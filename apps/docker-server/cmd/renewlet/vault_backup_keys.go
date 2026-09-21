package main

// vault_backup_keys.go 实现账号库备份密码（backup envelope）与手动导出。
//
// 架构位置：
//   - 备份密码 passphrase → Argon2id（salt 随机 32B）→ KEK 32B；KEK 直接 AES-256-GCM
//     加密每条凭据明文 password/notes（复用 v1.nonce.ct 格式），GCM 认证失败即密码错误。
//   - backup_keys 只存 kdfSalt/kdfParams/wrappedKek/verifier：wrappedKek 用实例
//     backup-kek-wrap 域加密（仅供自动云备份在本实例解封），verifier 用于校验密码；
//     明文密码永不入库、永不进日志。
//   - 备份包离开实例后只依赖 passphrase + 包内 backupEnvelope（salt/params），
//     改密码生成新 salt 不影响旧备份包。
import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"golang.org/x/crypto/argon2"
)

const (
	backupKDFVersion       = 1
	backupKDFMemoryKiB     = 64 * 1024 // 64 MiB
	backupKDFIterations    = 3
	backupKDFParallelism   = 4
	backupKDFSaltBytes     = 32
	backupKDFKeyBytes      = 32
	backupPassphraseMinLen = 8
	backupPassphraseMaxLen = 256
	// verifier 明文固定串：用 KEK 解密后比对，等价于不落库的密码校验。
	backupVerifierPlaintext = "renewo-backup-kek-verifier-v1"
	// 与 shared IMPORT_VAULT_CREDENTIALS_LIMIT 对齐。
	maxVaultExportCredentials = 200

	vaultLogActionBackupKeySet        = "backup_key_set"
	vaultLogActionBackupKeyChanged    = "backup_key_changed"
	vaultLogActionBackupKeyDeleted    = "backup_key_deleted"
	vaultLogActionBackupExported      = "backup_export"
	vaultLogActionCredentialsRestored = "credentials_restored"
)

var errBackupPassphraseInvalid = errors.New("BACKUP_PASSPHRASE_INVALID")

// ================== KDF 与 KEK 封装 ==================

type backupKdfParams struct {
	MemoryKiB   int `json:"memoryKiB"`
	Iterations  int `json:"iterations"`
	Parallelism int `json:"parallelism"`
}

// backupEnvelope 随导出包进 data.json：目标实例凭 salt+params 复算 KEK 解密凭据。
type backupEnvelope struct {
	KDF     string          `json:"kdf"`
	Version int             `json:"version"`
	Salt    string          `json:"salt"`
	Params  backupKdfParams `json:"params"`
}

func deriveBackupKEK(passphrase string, salt []byte) []byte {
	return argon2.IDKey([]byte(passphrase), salt, backupKDFIterations, backupKDFMemoryKiB, backupKDFParallelism, backupKDFKeyBytes)
}

func currentBackupKdfParams() backupKdfParams {
	return backupKdfParams{MemoryKiB: backupKDFMemoryKiB, Iterations: backupKDFIterations, Parallelism: backupKDFParallelism}
}

// validateBackupEnvelope 校验恢复包内 envelope 形状；返回可复算 KEK 的盐字节。
func validateBackupEnvelope(envelope *backupEnvelope) ([]byte, error) {
	if envelope == nil || envelope.KDF != "argon2id" || envelope.Version != backupKDFVersion {
		return nil, errors.New("IMPORT_VAULT_BACKUP_ENVELOPE_INVALID")
	}
	if envelope.Params.MemoryKiB <= 0 || envelope.Params.Iterations <= 0 || envelope.Params.Parallelism <= 0 {
		return nil, errors.New("IMPORT_VAULT_BACKUP_ENVELOPE_INVALID")
	}
	salt, err := base64.RawURLEncoding.DecodeString(envelope.Salt)
	if err != nil || len(salt) < 16 {
		return nil, errors.New("IMPORT_VAULT_BACKUP_ENVELOPE_INVALID")
	}
	return salt, nil
}

// ================== backup_keys 记录读写 ==================

func findBackupKeyRecord(app core.App, userID string) (*core.Record, error) {
	record, err := app.FindFirstRecordByFilter("backup_keys", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return record, nil
}

// backupKeysConfigured 返回用户是否已设置备份密码；读取失败按未设置处理（建表前兼容）。
func backupKeysConfigured(app core.App, userID string) bool {
	record, err := findBackupKeyRecord(app, userID)
	return err == nil && record != nil
}

// backupEnvelopeFromRecord 从 backup_keys 记录构造随包导出的 envelope。
func backupEnvelopeFromRecord(record *core.Record) (backupEnvelope, error) {
	params := currentBackupKdfParams()
	if raw := record.GetString("kdfParams"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &params); err != nil {
			return backupEnvelope{}, err
		}
	}
	return backupEnvelope{
		KDF:     "argon2id",
		Version: backupKDFVersion,
		Salt:    record.GetString("kdfSalt"),
		Params:  params,
	}, nil
}

// unwrapBackupKEK 用实例 backup-kek-wrap 域解封 wrappedKek，得到 KEK 原始字节。
func unwrapBackupKEK(app core.App, record *core.Record) ([]byte, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return nil, err
	}
	wrapped, err := decryptAESGCMWithKey(ring.backupKekWrap, record.GetString("wrappedKek"))
	if err != nil {
		return nil, err
	}
	kek, err := base64.RawURLEncoding.DecodeString(wrapped)
	if err != nil || len(kek) != backupKDFKeyBytes {
		return nil, errors.New("invalid wrapped backup kek")
	}
	return kek, nil
}

// verifyBackupPassphrase 派生 KEK 解 verifier；GCM 认证失败返回 errBackupPassphraseInvalid。
func verifyBackupPassphrase(record *core.Record, passphrase string) error {
	salt, err := base64.RawURLEncoding.DecodeString(record.GetString("kdfSalt"))
	if err != nil || len(salt) < 16 {
		return errors.New("invalid backup key salt")
	}
	kek := deriveBackupKEK(passphrase, salt)
	plaintext, err := decryptAESGCMWithKey(kek, record.GetString("verifier"))
	if err != nil || plaintext != backupVerifierPlaintext {
		return errBackupPassphraseInvalid
	}
	return nil
}

// sealBackupKEK 用 backup-kek-wrap 域包裹 KEK（base64 后加密），供自动云备份解封。
func sealBackupKEK(app core.App, kek []byte) (string, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	return encryptAESGCMWithKey(ring.backupKekWrap, base64.RawURLEncoding.EncodeToString(kek))
}

// sealBackupVerifier 用 KEK 加密固定校验串。
func sealBackupVerifier(kek []byte) (string, error) {
	return encryptAESGCMWithKey(kek, backupVerifierPlaintext)
}

// ================== 备份密码路由 ==================

type vaultBackupKeyStatusResponse struct {
	Configured bool `json:"configured"`
}

type vaultBackupKeySetRequest struct {
	Passphrase string `json:"passphrase"`
}

type vaultBackupKeyChangeRequest struct {
	CurrentPassphrase string `json:"currentPassphrase"`
	NewPassphrase     string `json:"newPassphrase"`
}

type vaultBackupKeyDeleteRequest struct {
	Passphrase string `json:"passphrase"`
}

func validateBackupPassphraseFormat(passphrase string) bool {
	length := len([]rune(passphrase))
	return length >= backupPassphraseMinLen && length <= backupPassphraseMaxLen
}

func handleVaultBackupKeyStatus(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findBackupKeyRecord(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, vaultBackupKeyStatusResponse{Configured: record != nil})
}

func handleVaultBackupKeySet(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[vaultBackupKeySetRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !validateBackupPassphraseFormat(body.Passphrase) {
		return e.BadRequestError(serverText(locale, "vault.backupKeys.invalid"), nil)
	}
	existing, err := findBackupKeyRecord(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if existing != nil {
		return e.BadRequestError(serverText(locale, "vault.backupKeys.alreadySet"), nil)
	}
	if err := saveBackupKeyRecord(app, e, locale, body.Passphrase); err != nil {
		return err
	}
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionBackupKeySet, vaultLogSourceAdmin, vaultLogResultSuccess,
		"", "", "", clientIP(e.Request), e.Request.UserAgent(), nil)
	return apiSuccessJSON(e, http.StatusCreated, vaultBackupKeyStatusResponse{Configured: true})
}

// saveBackupKeyRecord 生成新盐/新 KEK 并落 backup_keys 记录；set 与 change 共用。
func saveBackupKeyRecord(app core.App, e *core.RequestEvent, locale appLocale, passphrase string) error {
	collection, err := app.FindCollectionByNameOrId("backup_keys")
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	record, findErr := findBackupKeyRecord(app, e.Auth.Id)
	if findErr != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), findErr)
	}
	if record == nil {
		record = core.NewRecord(collection)
		record.Set("user", e.Auth.Id)
	}
	salt := make([]byte, backupKDFSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	kek := deriveBackupKEK(passphrase, salt)
	wrappedKek, err := sealBackupKEK(app, kek)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	verifier, err := sealBackupVerifier(kek)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	paramsJSON, err := json.Marshal(currentBackupKdfParams())
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	record.Set("kdfSalt", base64.RawURLEncoding.EncodeToString(salt))
	record.Set("kdfParams", paramsJSON)
	record.Set("wrappedKek", wrappedKek)
	record.Set("verifier", verifier)
	if err := app.Save(record); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	return nil
}

func handleVaultBackupKeyChange(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[vaultBackupKeyChangeRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := findBackupKeyRecord(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if record == nil {
		return apiErrorJSON(e, http.StatusBadRequest, "VAULT_BACKUP_KEY_NOT_CONFIGURED", serverText(locale, "vault.backupKeys.notConfigured"), nil)
	}
	if !validateBackupPassphraseFormat(body.NewPassphrase) {
		return apiErrorJSON(e, http.StatusBadRequest, "VAULT_BACKUP_PASSPHRASE_INVALID_FORMAT", serverText(locale, "vault.backupKeys.invalid"), nil)
	}
	if err := verifyBackupPassphrase(record, body.CurrentPassphrase); err != nil {
		writeVaultAccessLog(app, e.Auth.Id, vaultLogActionBackupKeyChanged, vaultLogSourceAdmin, vaultLogResultFailure,
			"", "", "", clientIP(e.Request), e.Request.UserAgent(), map[string]any{"reason": "wrong passphrase"})
		return apiErrorJSON(e, http.StatusBadRequest, "VAULT_BACKUP_PASSPHRASE_WRONG", serverText(locale, "vault.backupKeys.wrongPassphrase"), nil)
	}
	if err := saveBackupKeyRecord(app, e, locale, body.NewPassphrase); err != nil {
		return err
	}
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionBackupKeyChanged, vaultLogSourceAdmin, vaultLogResultSuccess,
		"", "", "", clientIP(e.Request), e.Request.UserAgent(), nil)
	return apiSuccessJSON(e, http.StatusOK, vaultBackupKeyStatusResponse{Configured: true})
}

func handleVaultBackupKeyDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[vaultBackupKeyDeleteRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := findBackupKeyRecord(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if record == nil {
		return apiErrorJSON(e, http.StatusBadRequest, "VAULT_BACKUP_KEY_NOT_CONFIGURED", serverText(locale, "vault.backupKeys.notConfigured"), nil)
	}
	if err := verifyBackupPassphrase(record, body.Passphrase); err != nil {
		writeVaultAccessLog(app, e.Auth.Id, vaultLogActionBackupKeyDeleted, vaultLogSourceAdmin, vaultLogResultFailure,
			"", "", "", clientIP(e.Request), e.Request.UserAgent(), map[string]any{"reason": "wrong passphrase"})
		return apiErrorJSON(e, http.StatusBadRequest, "VAULT_BACKUP_PASSPHRASE_WRONG", serverText(locale, "vault.backupKeys.wrongPassphrase"), nil)
	}
	if err := app.Delete(record); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionBackupKeyDeleted, vaultLogSourceAdmin, vaultLogResultSuccess,
		"", "", "", clientIP(e.Request), e.Request.UserAgent(), nil)
	return apiEmptySuccessJSON(e, http.StatusOK)
}

// ================== 手动导出 ==================

type vaultExportRequest struct {
	Passphrase string `json:"passphrase"`
}

type vaultExportCredential struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	Username       string `json:"username"`
	SortOrder      int    `json:"sortOrder"`
	SubscriptionID string `json:"subscriptionId"`
	GroupID        string `json:"groupId"`
	PasswordBackup string `json:"passwordBackup"`
	NotesBackup    string `json:"notesBackup"`
}

type vaultExportResponse struct {
	BackupEnvelope   backupEnvelope          `json:"backupEnvelope"`
	VaultCredentials []vaultExportCredential `json:"vaultCredentials"`
}

// 手动导出的密码校验按用户+IP 限流： passphrase 无法离线爆破，在线尝试必须慢下来。
const (
	vaultExportRateLimitMax    = 5
	vaultExportRateLimitWindow = time.Minute
)

type vaultExportBucket struct {
	Count   int
	ResetAt time.Time
}

var (
	vaultExportMu    sync.Mutex
	vaultExportLimit = map[string]vaultExportBucket{}
)

func checkVaultExportRateLimit(e *core.RequestEvent) bool {
	now := time.Now()
	key := e.Auth.Id + ":" + clientIP(e.Request)
	vaultExportMu.Lock()
	defer vaultExportMu.Unlock()
	if bucket, ok := vaultExportLimit[key]; ok {
		if now.Before(bucket.ResetAt) {
			if bucket.Count >= vaultExportRateLimitMax {
				return false
			}
			bucket.Count++
			vaultExportLimit[key] = bucket
			return true
		}
	}
	vaultExportLimit[key] = vaultExportBucket{Count: 1, ResetAt: now.Add(vaultExportRateLimitWindow)}
	if len(vaultExportLimit) > 4096 {
		for k, v := range vaultExportLimit {
			if now.After(v.ResetAt) {
				delete(vaultExportLimit, k)
			}
		}
	}
	return true
}

// handleVaultExport 手动导出账号库凭据：verifier 校验备份密码后，用 vault 域解密、KEK 重加密返回。
// 导出动作（含失败尝试）落审计日志；明文密码只以 KEK 密文形态离开服务端。
func handleVaultExport(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findBackupKeyRecord(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if record == nil {
		return apiErrorJSON(e, http.StatusBadRequest, "VAULT_BACKUP_KEY_NOT_CONFIGURED", serverText(locale, "vault.backupKeys.notConfigured"), nil)
	}
	if !checkVaultExportRateLimit(e) {
		return e.TooManyRequestsError(serverText(locale, "vault.publicRedeemRateLimited"), nil)
	}
	body, err := decodeStrictJSON[vaultExportRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := verifyBackupPassphrase(record, body.Passphrase); err != nil {
		writeVaultAccessLog(app, e.Auth.Id, vaultLogActionBackupExported, vaultLogSourceAdmin, vaultLogResultFailure,
			"", "", "", clientIP(e.Request), e.Request.UserAgent(), map[string]any{"reason": "wrong passphrase"})
		return apiErrorJSON(e, http.StatusBadRequest, "VAULT_BACKUP_PASSPHRASE_WRONG", serverText(locale, "vault.backupKeys.wrongPassphrase"), nil)
	}
	kek, err := deriveBackupKEKFromRecord(record, body.Passphrase)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	envelope, err := backupEnvelopeFromRecord(record)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	credentials, err := collectVaultExportCredentials(app, e.Auth.Id, kek)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionBackupExported, vaultLogSourceAdmin, vaultLogResultSuccess,
		"", "", "", clientIP(e.Request), e.Request.UserAgent(), map[string]any{"credentials": len(credentials)})
	return apiSuccessJSON(e, http.StatusOK, vaultExportResponse{BackupEnvelope: envelope, VaultCredentials: credentials})
}

func deriveBackupKEKFromRecord(record *core.Record, passphrase string) ([]byte, error) {
	salt, err := base64.RawURLEncoding.DecodeString(record.GetString("kdfSalt"))
	if err != nil || len(salt) < 16 {
		return nil, errors.New("invalid backup key salt")
	}
	return deriveBackupKEK(passphrase, salt), nil
}

// collectVaultExportCredentials 用 vault 域解密明文后立即用 KEK 重加密；上限与导入契约对齐。
func collectVaultExportCredentials(app core.App, userID string, kek []byte) ([]vaultExportCredential, error) {
	records, err := app.FindRecordsByFilter(
		"vault_credentials",
		"user = {:user}",
		"sortOrder, created, -id",
		maxVaultExportCredentials,
		0,
		dbx.Params{"user": userID},
	)
	if err != nil {
		return nil, err
	}
	credentials := make([]vaultExportCredential, 0, len(records))
	for _, record := range records {
		item := vaultExportCredential{
			ID:             record.Id,
			Title:          record.GetString("title"),
			URL:            record.GetString("url"),
			Username:       record.GetString("username"),
			SortOrder:      int(record.GetInt("sortOrder")),
			SubscriptionID: record.GetString("subscription"),
			GroupID:        record.GetString("group"),
		}
		if ciphertext := record.GetString("passwordCiphertext"); ciphertext != "" {
			plaintext, decErr := decryptVaultSecret(app, ciphertext)
			if decErr != nil {
				return nil, decErr
			}
			if item.PasswordBackup, err = encryptAESGCMWithKey(kek, plaintext); err != nil {
				return nil, err
			}
		}
		if ciphertext := record.GetString("notesCiphertext"); ciphertext != "" {
			plaintext, decErr := decryptVaultSecret(app, ciphertext)
			if decErr != nil {
				return nil, decErr
			}
			if item.NotesBackup, err = encryptAESGCMWithKey(kek, plaintext); err != nil {
				return nil, err
			}
		}
		credentials = append(credentials, item)
	}
	return credentials, nil
}

// ================== 导入前备份密码预检（不写库） ==================

type vaultImportVerifyRequest struct {
	Envelope   backupEnvelope `json:"envelope"`
	Ciphertext string         `json:"ciphertext"`
	Passphrase string         `json:"passphrase"`
}

type vaultImportVerifyResponse struct {
	Valid bool `json:"valid"`
}

// handleVaultImportVerifyPassphrase 在 apply 前用包内 envelope 派生 KEK 试解密一条密文，
// 判断备份密码是否正确；不读取/写入任何业务数据。限流与手动导出共用 Argon2 试错桶。
func handleVaultImportVerifyPassphrase(_ core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if !checkVaultExportRateLimit(e) {
		return e.TooManyRequestsError(serverText(locale, "vault.publicRedeemRateLimited"), nil)
	}
	body, err := decodeStrictJSON[vaultImportVerifyRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if strings.TrimSpace(body.Passphrase) == "" {
		return apiSuccessJSON(e, http.StatusOK, vaultImportVerifyResponse{Valid: false})
	}
	salt, err := validateBackupEnvelope(&body.Envelope)
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestBody"), err)
	}
	ciphertext := strings.TrimSpace(body.Ciphertext)
	if ciphertext == "" || validateBackupCiphertextFormat(ciphertext) != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestBody"), nil)
	}
	kek := deriveBackupKEK(body.Passphrase, salt)
	if _, err := decryptAESGCMWithKey(kek, ciphertext); err != nil {
		// GCM 认证失败即密码错误；格式错误在上面已挡掉。
		return apiSuccessJSON(e, http.StatusOK, vaultImportVerifyResponse{Valid: false})
	}
	return apiSuccessJSON(e, http.StatusOK, vaultImportVerifyResponse{Valid: true})
}
