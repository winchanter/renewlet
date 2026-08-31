package main

// vault.go 承载账号库（Credential Vault）的产品 API。
//
// 架构位置：
//   - 密码与备注只在服务端经账号安全密钥环的 vault 用途域加解密；列表/详情响应永不携带密文，
//     明文密码仅通过显式 reveal 动作返回并写审计日志。
//   - 归属边界与订阅路由一致：查询同时带 id 和 user，避免通过错误码枚举他人凭据。
import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	vaultTitleMax    = 120
	vaultURLMax      = 2048
	vaultUsernameMax = 200
	vaultPasswordMax = 1024
	vaultNotesMax    = 5000

	vaultLogActionCredentialViewed  = "credential_viewed"
	vaultLogActionCredentialCreated = "credential_created"
	vaultLogActionCredentialUpdated = "credential_updated"
	vaultLogActionCredentialDeleted = "credential_deleted"
	vaultLogActionCodeGenerated     = "code_generated"
	vaultLogActionCodeRedeemed      = "code_redeemed"
	vaultLogActionCodeRevoked       = "code_revoked"
	vaultLogActionCodeViewed        = "code_viewed"
	vaultLogActionRequestSubmitted  = "request_submitted"
	vaultLogActionRequestApproved   = "request_approved"
	vaultLogActionRequestDeclined   = "request_declined"
	vaultLogActionRequestClosed     = "request_closed"
	vaultLogSourceAdmin             = "admin"
	vaultLogSourcePublic            = "public"
	vaultLogResultSuccess           = "success"
	vaultLogResultFailure           = "failure"
	vaultCodeMaxAttemptsDefault     = 5
	vaultCodeExpireHoursDefault     = 48
	vaultCodeExpireHoursMax         = 7 * 24
	vaultRequestStatusPending       = "pending"
	vaultRequestStatusApproved      = "approved"
	vaultRequestStatusDeclined      = "declined"
	vaultRequestStatusExpired       = "expired"
	vaultRequestStatusClosed        = "closed"
)

type vaultCredentialView struct {
	ID             string `json:"id"`
	SubscriptionID string `json:"subscriptionId"`
	GroupID        string `json:"groupId"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	Username       string `json:"username"`
	Notes          string `json:"notes"`
	HasPassword    bool   `json:"hasPassword"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

type vaultCredentialsListResponse struct {
	Credentials []vaultCredentialView `json:"credentials"`
}

// vaultCredentialCreateRequest 只服务创建路径；缺省字段一律落空值，避免创建语义里混入 PATCH 三态。
type vaultCredentialCreateRequest struct {
	SubscriptionID string `json:"subscriptionId"`
	GroupID        string `json:"groupId"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	Notes          string `json:"notes"`
}

// vaultCredentialUpdateRequest 区分缺字段、显式 null 与空串：null 清空，缺省保持不变，密码不 trim。
type vaultCredentialUpdateRequest struct {
	SubscriptionID optionalJSONField[string] `json:"subscriptionId"`
	GroupID        optionalJSONField[string] `json:"groupId"`
	Title          optionalJSONField[string] `json:"title"`
	URL            optionalJSONField[string] `json:"url"`
	Username       optionalJSONField[string] `json:"username"`
	Password       optionalJSONField[string] `json:"password"`
	Notes          optionalJSONField[string] `json:"notes"`
}

func (r vaultCredentialUpdateRequest) HasChanges() bool {
	return r.SubscriptionID.Set || r.GroupID.Set || r.Title.Set || r.URL.Set || r.Username.Set ||
		r.Password.Set || r.Notes.Set
}

type vaultCredentialRevealResponse struct {
	Password string `json:"password"`
}

// encryptVaultSecret 用账号安全密钥环的 vault 用途域加密；与 TOTP seed 同格式（v1.nonce.ciphertext）。
func encryptVaultSecret(app core.App, plaintext string) (string, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	return encryptAESGCMWithKey(ring.vaultData, plaintext)
}

func decryptVaultSecret(app core.App, value string) (string, error) {
	ring, err := accountSecurityKeyRingForApp(app)
	if err != nil {
		return "", err
	}
	return decryptAESGCMWithKey(ring.vaultData, value)
}

func findOwnedVaultCredential(app core.App, e *core.RequestEvent) (*core.Record, error) {
	credentialID := strings.TrimSpace(e.Request.PathValue("id"))
	return app.FindFirstRecordByFilter(
		"vault_credentials",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": credentialID, "user": e.Auth.Id},
	)
}

// resolveVaultSubscriptionID 校验关联订阅归属；返回空串表示独立账号。
func resolveVaultSubscriptionID(app core.App, locale appLocale, userID, subscriptionID string) (string, error) {
	subscriptionID = strings.TrimSpace(subscriptionID)
	if subscriptionID == "" {
		return "", nil
	}
	record, err := app.FindFirstRecordByFilter(
		"subscriptions",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": subscriptionID, "user": userID},
	)
	if err != nil || record == nil {
		return "", errors.New(serverText(locale, "vault.subscriptionNotFound"))
	}
	return subscriptionID, nil
}

func vaultCredentialAPIFromRecord(app core.App, record *core.Record) vaultCredentialView {
	notes := ""
	if ciphertext := record.GetString("notesCiphertext"); ciphertext != "" {
		if plaintext, err := decryptVaultSecret(app, ciphertext); err == nil {
			notes = plaintext
		}
	}
	view := vaultCredentialView{
		ID:             record.Id,
		SubscriptionID: record.GetString("subscription"),
		GroupID:        record.GetString("group"),
		Title:          record.GetString("title"),
		URL:            record.GetString("url"),
		Username:       record.GetString("username"),
		Notes:          notes,
		HasPassword:    record.GetString("passwordCiphertext") != "",
	}
	if !record.GetDateTime("created").IsZero() {
		view.CreatedAt = record.GetDateTime("created").Time().UTC().Format(time.RFC3339Nano)
	}
	if !record.GetDateTime("updated").IsZero() {
		view.UpdatedAt = record.GetDateTime("updated").Time().UTC().Format(time.RFC3339Nano)
	}
	return view
}

// writeVaultAccessLog 记录审计事件；审计失败不阻塞业务动作，只暴露内部错误日志语义。
func writeVaultAccessLog(app core.App, userID string, action string, source string, result string, subscriptionID string, credentialID string, codeID string, ip string, userAgent string, detail any) {
	collection, err := app.FindCollectionByNameOrId("vault_access_logs")
	if err != nil {
		return
	}
	record := core.NewRecord(collection)
	record.Set("user", userID)
	record.Set("action", truncateVaultLogText(action, 40))
	record.Set("source", source)
	record.Set("result", result)
	record.Set("subscriptionId", truncateVaultLogText(subscriptionID, 128))
	record.Set("credentialId", truncateVaultLogText(credentialID, 128))
	record.Set("codeId", truncateVaultLogText(codeID, 128))
	record.Set("ip", truncateVaultLogText(ip, 64))
	record.Set("userAgent", truncateVaultLogText(userAgent, 300))
	if detail != nil {
		record.Set("detail", detail)
	}
	_ = app.Save(record)
}

func truncateVaultLogText(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max])
	}
	return value
}

func handleVaultCredentialsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	subscriptionFilter := strings.TrimSpace(e.Request.URL.Query().Get("subscriptionId"))
	groupFilter := strings.TrimSpace(e.Request.URL.Query().Get("groupId"))
	filter := "user = {:user}"
	params := dbx.Params{"user": e.Auth.Id}
	if subscriptionFilter != "" {
		// 订阅的关联账号 = 订阅级子账号 + 所属组的共享账号（组内共享语义）。
		filter += " && (subscription = {:subscription}"
		params["subscription"] = subscriptionFilter
		subscriptionRecord, subErr := app.FindFirstRecordByFilter(
			"subscriptions",
			"id = {:id} && user = {:user}",
			dbx.Params{"id": subscriptionFilter, "user": e.Auth.Id},
		)
		if subErr == nil && subscriptionRecord != nil {
			if groupID := subscriptionRecord.GetString("group"); groupID != "" {
				filter += " || group = {:subGroup}"
				params["subGroup"] = groupID
			}
		}
		filter += ")"
	}
	if groupFilter != "" {
		filter += " && group = {:group}"
		params["group"] = groupFilter
	}
	records, err := app.FindRecordsByFilter("vault_credentials", filter, "-created, -id", 0, 0, params)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	credentials := make([]vaultCredentialView, 0, len(records))
	for _, record := range records {
		credentials = append(credentials, vaultCredentialAPIFromRecord(app, record))
	}
	return apiSuccessJSON(e, http.StatusOK, vaultCredentialsListResponse{Credentials: credentials})
}

func handleVaultCredentialGet(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findOwnedVaultCredential(app, e)
	if err != nil || record == nil {
		// 非归属者返回 404 而非 403/405，避免泄露凭据是否存在。
		return e.NotFoundError(serverText(locale, "vault.notFound"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, vaultCredentialAPIFromRecord(app, record))
}

func handleVaultCredentialCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[vaultCredentialCreateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	title := strings.TrimSpace(body.Title)
	if title == "" || len([]rune(title)) > vaultTitleMax {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	subscriptionID, err := resolveVaultSubscriptionID(app, locale, e.Auth.Id, body.SubscriptionID)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	groupID, _, err := resolveSubscriptionGroupID(app, locale, e.Auth.Id, body.GroupID)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	// subscription 与 group 互斥：组级共享账号与订阅级子账号不能同时绑定。
	if subscriptionID != "" && groupID != "" {
		return e.BadRequestError(serverText(locale, "vault.subscriptionGroupMutex"), nil)
	}
	if len([]rune(body.URL)) > vaultURLMax || len([]rune(body.Username)) > vaultUsernameMax ||
		len([]rune(body.Password)) > vaultPasswordMax || len([]rune(body.Notes)) > vaultNotesMax {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	collection, err := app.FindCollectionByNameOrId("vault_credentials")
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	record := core.NewRecord(collection)
	record.Set("user", e.Auth.Id)
	record.Set("subscription", subscriptionID)
	record.Set("group", groupID)
	record.Set("title", title)
	record.Set("url", strings.TrimSpace(body.URL))
	record.Set("username", strings.TrimSpace(body.Username))
	if body.Password != "" {
		ciphertext, err := encryptVaultSecret(app, body.Password)
		if err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		record.Set("passwordCiphertext", ciphertext)
	}
	if strings.TrimSpace(body.Notes) != "" {
		ciphertext, err := encryptVaultSecret(app, body.Notes)
		if err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		record.Set("notesCiphertext", ciphertext)
	}
	if err := app.Save(record); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionCredentialCreated, vaultLogSourceAdmin, vaultLogResultSuccess,
		subscriptionID, record.Id, "", clientIP(e.Request), e.Request.UserAgent(), nil)
	return apiSuccessJSON(e, http.StatusCreated, vaultCredentialAPIFromRecord(app, record))
}

func handleVaultCredentialUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[vaultCredentialUpdateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if !body.HasChanges() {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	record, err := findOwnedVaultCredential(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "vault.notFound"), err)
	}
	if body.SubscriptionID.Set {
		subscriptionID, resolveErr := resolveVaultSubscriptionID(app, locale, e.Auth.Id, body.SubscriptionID.Value)
		if resolveErr != nil {
			return e.BadRequestError(resolveErr.Error(), nil)
		}
		record.Set("subscription", subscriptionID)
	}
	if body.GroupID.Set {
		groupID, _, resolveErr := resolveSubscriptionGroupID(app, locale, e.Auth.Id, body.GroupID.Value)
		if resolveErr != nil {
			return e.BadRequestError(resolveErr.Error(), nil)
		}
		record.Set("group", groupID)
	}
	// 写入后校验互斥：subscription 与 group 不能同时非空。
	if record.GetString("subscription") != "" && record.GetString("group") != "" {
		return e.BadRequestError(serverText(locale, "vault.subscriptionGroupMutex"), nil)
	}
	if body.Title.Set {
		title := strings.TrimSpace(body.Title.Value)
		if title == "" || len([]rune(title)) > vaultTitleMax {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		record.Set("title", title)
	}
	if body.URL.Set {
		if body.URL.Null || len([]rune(body.URL.Value)) > vaultURLMax {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		record.Set("url", strings.TrimSpace(body.URL.Value))
	}
	if body.Username.Set {
		if body.Username.Null || len([]rune(body.Username.Value)) > vaultUsernameMax {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		record.Set("username", strings.TrimSpace(body.Username.Value))
	}
	if body.Notes.Set {
		if body.Notes.Null || len([]rune(body.Notes.Value)) > vaultNotesMax {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		if strings.TrimSpace(body.Notes.Value) == "" {
			record.Set("notesCiphertext", "")
		} else {
			ciphertext, encryptErr := encryptVaultSecret(app, body.Notes.Value)
			if encryptErr != nil {
				return e.InternalServerError(serverText(locale, "common.internalError"), encryptErr)
			}
			record.Set("notesCiphertext", ciphertext)
		}
	}
	if body.Password.Set {
		// 密码不 trim；显式 null 与空串都表示清除已存密码。
		if body.Password.Null || body.Password.Value == "" {
			record.Set("passwordCiphertext", "")
		} else {
			if len([]rune(body.Password.Value)) > vaultPasswordMax {
				return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
			}
			ciphertext, encryptErr := encryptVaultSecret(app, body.Password.Value)
			if encryptErr != nil {
				return e.InternalServerError(serverText(locale, "common.internalError"), encryptErr)
			}
			record.Set("passwordCiphertext", ciphertext)
		}
	}
	if err := app.Save(record); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionCredentialUpdated, vaultLogSourceAdmin, vaultLogResultSuccess,
		record.GetString("subscription"), record.Id, "", clientIP(e.Request), e.Request.UserAgent(), nil)
	return apiSuccessJSON(e, http.StatusOK, vaultCredentialAPIFromRecord(app, record))
}

func handleVaultCredentialDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findOwnedVaultCredential(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "vault.notFound"), err)
	}
	subscriptionID := record.GetString("subscription")
	credentialID := record.Id
	if err := app.Delete(record); err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionCredentialDeleted, vaultLogSourceAdmin, vaultLogResultSuccess,
		subscriptionID, credentialID, "", clientIP(e.Request), e.Request.UserAgent(), nil)
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func handleVaultCredentialReveal(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findOwnedVaultCredential(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "vault.notFound"), err)
	}
	password := ""
	if ciphertext := record.GetString("passwordCiphertext"); ciphertext != "" {
		plaintext, decryptErr := decryptVaultSecret(app, ciphertext)
		if decryptErr != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), decryptErr)
		}
		password = plaintext
	}
	// reveal 是明文离开服务端的唯一通道；必须落审计，ip/ua 让异常查看可追溯。
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionCredentialViewed, vaultLogSourceAdmin, vaultLogResultSuccess,
		record.GetString("subscription"), record.Id, "", clientIP(e.Request), e.Request.UserAgent(), nil)
	return apiSuccessJSON(e, http.StatusOK, vaultCredentialRevealResponse{Password: password})
}

// ================== P2-A：一次性访问授权码 ==================

type vaultAccessCodeCreateRequest struct {
	CredentialID string `json:"credentialId"`
	Note         string `json:"note"`
	ExpireHours  int    `json:"expireHours"`
	MaxAttempts  int    `json:"maxAttempts"`
}

type vaultAccessCodeView struct {
	ID              string `json:"id"`
	CredentialID    string `json:"credentialId"`
	CredentialTitle string `json:"credentialTitle"`
	SubscriptionID  string `json:"subscriptionId"` // 冗余快照，可能为空（独立账号）
	CodeMask        string `json:"codeMask"`
	Note            string `json:"note"`
	ExpiresAt       string `json:"expiresAt"`
	MaxAttempts     int    `json:"maxAttempts"`
	Attempts        int    `json:"attempts"`
	Status          string `json:"status"` // active / used / revoked / expired
	UsedAt          string `json:"usedAt"`
	RevokedAt       string `json:"revokedAt"`
	RequestID       string `json:"requestId"`
	CreatedAt       string `json:"createdAt"`
	// HasPlainCode 表示明文已加密存档、可重复查阅；旧版（hash-only 时期）生成的码为 false。
	HasPlainCode bool `json:"hasPlainCode"`
}

type vaultAccessCodeCreatedResponse struct {
	vaultAccessCodeView
	PlainCode string `json:"plainCode"`
}

type vaultAccessCodePlainRevealResponse struct {
	PlainCode string `json:"plainCode"`
}

type vaultAccessCodesListResponse struct {
	Codes []vaultAccessCodeView `json:"codes"`
}

type vaultAccessCodeRedeemRequest struct {
	Code string `json:"code"`
}

type vaultAccessCodeRedeemResponse struct {
	Password         string `json:"password"`
	CredentialID     string `json:"credentialId"`
	SubscriptionID   string `json:"subscriptionId"`
	GroupID          string `json:"groupId"`
	SubscriptionName string `json:"subscriptionName"` // 冗余快照，可能为空（独立账号或订阅已删除）
	GroupName        string `json:"groupName"`        // 冗余快照，可能为空（未绑定组或组已删除）
	Title            string `json:"title"`
	URL              string `json:"url"`
	Username         string `json:"username"`
	Notes            string `json:"notes"`
}

func generateVaultAccessCode() (string, string, string, error) {
	data := make([]byte, 15)
	if _, err := rand.Read(data); err != nil {
		return "", "", "", err
	}
	plain := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(data))
	if len([]rune(plain)) > 16 {
		plain = string([]rune(plain)[:16])
	}
	sum := sha256.Sum256([]byte(plain))
	hash := hex.EncodeToString(sum[:])
	runes := []rune(plain)
	mask := string(runes[:3]) + strings.Repeat("•", len(runes)-5) + string(runes[len(runes)-2:])
	return plain, hash, mask, nil
}

func findOwnedVaultAccessCode(app core.App, e *core.RequestEvent) (*core.Record, error) {
	id := strings.TrimSpace(e.Request.PathValue("id"))
	return app.FindFirstRecordByFilter(
		"vault_access_codes",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": id, "user": e.Auth.Id},
	)
}

func vaultCodeStatusFromRecord(code *core.Record) string {
	if code.GetString("revokedAt") != "" {
		return "revoked"
	}
	// 旧版（按订阅绑定时期）生成的码没有 credential 绑定，无法兑换，呈现为已失效。
	if code.GetString("credential") == "" {
		return "revoked"
	}
	if code.GetString("usedAt") != "" {
		return "used"
	}
	// 额度已耗尽但 usedAt 未置位的历史数据兜底：attempts 达到上限同样呈现为已用尽。
	if maxAttempts := code.GetInt("maxAttempts"); maxAttempts > 0 && int(code.GetInt("attempts")) >= int(maxAttempts) {
		return "used"
	}
	if expiresAt := code.GetString("expiresAt"); expiresAt != "" {
		if t, err := time.Parse(time.RFC3339, expiresAt); err == nil && t.Before(time.Now().UTC()) {
			return "expired"
		}
	}
	return "active"
}

func vaultAccessCodeAPIFromRecord(code *core.Record) vaultAccessCodeView {
	view := vaultAccessCodeView{
		ID:              code.Id,
		CredentialID:    code.GetString("credential"),
		CredentialTitle: code.GetString("credentialTitle"),
		SubscriptionID:  code.GetString("subscription"),
		CodeMask:        code.GetString("codeMask"),
		Note:            code.GetString("note"),
		ExpiresAt:       code.GetString("expiresAt"),
		MaxAttempts:     int(code.GetInt("maxAttempts")),
		Attempts:        int(code.GetInt("attempts")),
		Status:          vaultCodeStatusFromRecord(code),
		UsedAt:          code.GetString("usedAt"),
		RevokedAt:       code.GetString("revokedAt"),
		RequestID:       code.GetString("request"),
	}
	if !code.GetDateTime("created").IsZero() {
		view.CreatedAt = code.GetDateTime("created").Time().UTC().Format(time.RFC3339Nano)
	}
	view.HasPlainCode = code.GetString("plainCipher") != ""
	return view
}

// resolveVaultCredentialID 校验凭据归属；返回 (credentialRecord, subscriptionID 快照, err)。
// subscriptionID 可能为空（独立账号场景）。
func resolveVaultCredentialID(app core.App, locale appLocale, userID, credentialID string) (*core.Record, string, error) {
	credentialID = strings.TrimSpace(credentialID)
	if credentialID == "" {
		return nil, "", errors.New(serverText(locale, "vault.credentialRequired"))
	}
	record, err := app.FindFirstRecordByFilter(
		"vault_credentials",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": credentialID, "user": userID},
	)
	if err != nil || record == nil {
		return nil, "", errors.New(serverText(locale, "vault.notFound"))
	}
	return record, record.GetString("subscription"), nil
}

func handleVaultAccessCodesList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	credentialFilter := strings.TrimSpace(e.Request.URL.Query().Get("credentialId"))
	filter := "user = {:user}"
	params := dbx.Params{"user": e.Auth.Id}
	if credentialFilter != "" {
		filter += " && credential = {:credential}"
		params["credential"] = credentialFilter
	}
	records, err := app.FindRecordsByFilter("vault_access_codes", filter, "-created, -id", 0, 0, params)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	codes := make([]vaultAccessCodeView, 0, len(records))
	for _, record := range records {
		codes = append(codes, vaultAccessCodeAPIFromRecord(record))
	}
	return apiSuccessJSON(e, http.StatusOK, vaultAccessCodesListResponse{Codes: codes})
}

func handleVaultAccessCodeCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[vaultAccessCodeCreateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	credential, subscriptionID, credErr := resolveVaultCredentialID(app, locale, e.Auth.Id, body.CredentialID)
	if credErr != nil {
		return e.BadRequestError(credErr.Error(), nil)
	}
	expireHours := body.ExpireHours
	if expireHours <= 0 {
		expireHours = vaultCodeExpireHoursDefault
	}
	if expireHours > vaultCodeExpireHoursMax {
		expireHours = vaultCodeExpireHoursMax
	}
	maxAttempts := body.MaxAttempts
	if maxAttempts < 1 {
		maxAttempts = vaultCodeMaxAttemptsDefault
	}
	if len([]rune(body.Note)) > 500 {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	plainCode, codeHash, codeMask, genErr := generateVaultAccessCode()
	if genErr != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), genErr)
	}
	expiresAt := time.Now().UTC().Add(time.Duration(expireHours) * time.Hour).Format(time.RFC3339)
	// 明文加密存档（AES-256-GCM，vault 用途域）：管理员可在有效期内重复查阅；哈希仍用于兑换点查。
	plainCipher, encErr := encryptVaultSecret(app, plainCode)
	if encErr != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), encErr)
	}
	collection, findErr := app.FindCollectionByNameOrId("vault_access_codes")
	if findErr != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), findErr)
	}
	record := core.NewRecord(collection)
	record.Set("user", e.Auth.Id)
	record.Set("credential", credential.Id)
	record.Set("credentialTitle", credential.GetString("title"))
	record.Set("subscription", subscriptionID)
	record.Set("codeHash", codeHash)
	record.Set("plainCipher", plainCipher)
	record.Set("codeMask", codeMask)
	record.Set("note", body.Note)
	record.Set("expiresAt", expiresAt)
	record.Set("maxAttempts", float64(maxAttempts))
	record.Set("attempts", 0.0)
	if saveErr := app.Save(record); saveErr != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", saveErr), saveErr)
	}
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionCodeGenerated, vaultLogSourceAdmin, vaultLogResultSuccess,
		subscriptionID, credential.Id, record.Id, clientIP(e.Request), e.Request.UserAgent(), map[string]any{"expireHours": expireHours, "maxAttempts": maxAttempts})
	created := vaultAccessCodeAPIFromRecord(record)
	return apiSuccessJSON(e, http.StatusCreated, vaultAccessCodeCreatedResponse{vaultAccessCodeView: created, PlainCode: plainCode})
}

// handleVaultAccessCodeRevealPlain 管理员重复查阅授权码明文。
// 明文仅加密存档于 plainCipher（AES-256-GCM）；旧版 hash-only 生成的码无存档，返回专用文案。
func handleVaultAccessCodeRevealPlain(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findOwnedVaultAccessCode(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "vault.codeNotFound"), err)
	}
	cipher := record.GetString("plainCipher")
	if cipher == "" {
		return e.BadRequestError(serverText(locale, "vault.plainCodeUnavailable"), nil)
	}
	plain, decErr := decryptVaultSecret(app, cipher)
	if decErr != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), decErr)
	}
	// 与 credential reveal 同级敏感：明文离开服务端必须落审计，ip/ua 可追溯异常查阅。
	writeVaultAccessLog(app, e.Auth.Id, vaultLogActionCodeViewed, vaultLogSourceAdmin, vaultLogResultSuccess,
		record.GetString("subscription"), record.GetString("credential"), record.Id, clientIP(e.Request), e.Request.UserAgent(), nil)
	return apiSuccessJSON(e, http.StatusOK, vaultAccessCodePlainRevealResponse{PlainCode: plain})
}

func handleVaultAccessCodeRevoke(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findOwnedVaultAccessCode(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "vault.codeNotFound"), err)
	}
	if record.GetString("revokedAt") == "" && record.GetString("usedAt") == "" {
		record.Set("revokedAt", time.Now().UTC().Format(time.RFC3339))
		if saveErr := app.Save(record); saveErr != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), saveErr)
		}
		writeVaultAccessLog(app, e.Auth.Id, vaultLogActionCodeRevoked, vaultLogSourceAdmin, vaultLogResultSuccess,
			record.GetString("subscription"), record.GetString("credential"), record.Id, clientIP(e.Request), e.Request.UserAgent(), nil)
	}
	return apiEmptySuccessJSON(e, http.StatusOK)
}

// vaultAccessCodeRedeemCore 兑换授权码。ownerScope 非空时（公开页调用）码必须属于该用户，
// 不匹配一律按「码不存在」处理，避免公开 token 成为跨用户码枚举探针。
func vaultAccessCodeRedeemCore(app core.App, e *core.RequestEvent, body vaultAccessCodeRedeemRequest, userID string, source string, ownerScope string) error {
	locale := requestLocale(e.Request)
	codeText := strings.ToLower(strings.TrimSpace(body.Code))
	if codeText == "" {
		return e.BadRequestError(serverText(locale, "vault.codeRequired"), nil)
	}
	sum := sha256.Sum256([]byte(codeText))
	codeHash := hex.EncodeToString(sum[:])
	code, findErr := app.FindFirstRecordByFilter(
		"vault_access_codes",
		"codeHash = {:hash}",
		dbx.Params{"hash": codeHash},
	)
	ip := clientIP(e.Request)
	ua := e.Request.UserAgent()
	resultAction := vaultLogActionCodeRedeemed
	if findErr != nil || code == nil || (ownerScope != "" && code.GetString("user") != ownerScope) {
		logOwner := ""
		if code != nil {
			logOwner = code.GetString("user")
		}
		writeVaultAccessLog(app, logOwner, resultAction, source, vaultLogResultFailure, "", "", "", ip, ua, map[string]any{"reason": "code not found"})
		return e.BadRequestError(serverText(locale, "vault.codeInvalid"), nil)
	}
	attempts := int(code.GetInt("attempts"))
	maxAttempts := int(code.GetInt("maxAttempts"))
	codeOwner := code.GetString("user")
	credentialID := code.GetString("credential")
	subscriptionID := code.GetString("subscription")
	logContext := func(reason string) {
		writeVaultAccessLog(app, codeOwner, resultAction, source, vaultLogResultFailure, subscriptionID, credentialID, code.Id, ip, ua, map[string]any{"reason": reason})
	}
	if attempts+1 > maxAttempts {
		logContext("attempts exhausted")
		return e.BadRequestError(serverText(locale, "vault.codeExhausted"), nil)
	}
	now := time.Now().UTC()
	if code.GetString("revokedAt") != "" {
		logContext("revoked")
		return e.BadRequestError(serverText(locale, "vault.codeRevoked"), nil)
	}
	if code.GetString("usedAt") != "" {
		logContext("used")
		return e.BadRequestError(serverText(locale, "vault.codeUsed"), nil)
	}
	if expiresText := code.GetString("expiresAt"); expiresText != "" {
		if t, parseErr := time.Parse(time.RFC3339, expiresText); parseErr == nil && t.Before(now) {
			logContext("expired")
			return e.BadRequestError(serverText(locale, "vault.codeExpired"), nil)
		}
	}
	// 码本身已绑定 credentialID，直接查它（不再让兑换方再传 credentialId）。
	credential, credErr := app.FindFirstRecordByFilter(
		"vault_credentials",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": credentialID, "user": codeOwner},
	)
	if credErr != nil || credential == nil {
		writeVaultAccessLog(app, codeOwner, resultAction, source, vaultLogResultFailure, subscriptionID, credentialID, code.Id, ip, ua, map[string]any{"reason": "credential missing"})
		return e.NotFoundError(serverText(locale, "vault.notFound"), credErr)
	}
	// 消耗一次额度（attempts++）。usedAt 仅在最后一次可用额度时置位 —— 其语义是「额度用尽时刻」，
	// 使 maxAttempts>1 的码可多次成功兑换；max=1 保持一次性语义不变。
	newAttempts := attempts + 1
	code.Set("attempts", float64(newAttempts))
	password := ""
	if ciphertext := credential.GetString("passwordCiphertext"); ciphertext != "" {
		if plaintext, decryptErr := decryptVaultSecret(app, ciphertext); decryptErr == nil {
			password = plaintext
		}
	}
	if newAttempts >= maxAttempts {
		code.Set("usedAt", now.Format(time.RFC3339))
	}
	if saveErr := app.Save(code); saveErr != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), saveErr)
	}
	notes := ""
	if ciphertext := credential.GetString("notesCiphertext"); ciphertext != "" {
		if plaintext, decryptErr := decryptVaultSecret(app, ciphertext); decryptErr == nil {
			notes = plaintext
		}
	}
	writeVaultAccessLog(app, codeOwner, resultAction, source, vaultLogResultSuccess,
		subscriptionID, credential.Id, code.Id, ip, ua, map[string]any{"user": userID})
	// 冗余名称快照：用于 redeem 结果回显关联订阅/组名，避免前端（尤其未登录的公开页访客）再查。
	// 实体已删除时返回空串，前端不渲染对应行。
	groupID := credential.GetString("group")
	subscriptionName, groupName := "", ""
	// 审批访问申请生成的码带 request 记录：名称以申请目标（订阅/组）优先——这才是码的用途，
	// 因为审批所选账号可能是组共享账号，并不直接挂靠在被申请的订阅下。
	// 无申请记录（手动创建的码）或申请/实体已删除时，回退到账号自身归属。
	reqSubscriptionID, reqGroupID := "", ""
	if reqID := code.GetString("request"); reqID != "" {
		if req, reqErr := app.FindFirstRecordByFilter(
			"vault_access_requests",
			"id = {:id} && user = {:user}",
			dbx.Params{"id": reqID, "user": codeOwner},
		); reqErr == nil && req != nil {
			reqSubscriptionID = req.GetString("subscription")
			reqGroupID = req.GetString("group")
		}
	}
	if reqSubscriptionID != "" {
		if sub, subErr := app.FindFirstRecordByFilter("subscriptions", "id = {:id} && user = {:user}", dbx.Params{"id": reqSubscriptionID, "user": codeOwner}); subErr == nil && sub != nil {
			subscriptionName = sub.GetString("name")
		}
	} else if subscriptionID != "" {
		if sub, subErr := app.FindFirstRecordByFilter("subscriptions", "id = {:id} && user = {:user}", dbx.Params{"id": subscriptionID, "user": codeOwner}); subErr == nil && sub != nil {
			subscriptionName = sub.GetString("name")
		}
	}
	if reqGroupID != "" {
		if grp, grpErr := app.FindFirstRecordByFilter("subscription_groups", "id = {:id} && user = {:user}", dbx.Params{"id": reqGroupID, "user": codeOwner}); grpErr == nil && grp != nil {
			groupName = grp.GetString("name")
		}
	} else if groupID != "" {
		if grp, grpErr := app.FindFirstRecordByFilter("subscription_groups", "id = {:id} && user = {:user}", dbx.Params{"id": groupID, "user": codeOwner}); grpErr == nil && grp != nil {
			groupName = grp.GetString("name")
		}
	}
	return apiSuccessJSON(e, http.StatusOK, vaultAccessCodeRedeemResponse{
		Password:         password,
		CredentialID:     credential.Id,
		SubscriptionID:   subscriptionID,
		GroupID:          groupID,
		SubscriptionName: subscriptionName,
		GroupName:        groupName,
		Title:            credential.GetString("title"),
		URL:              credential.GetString("url"),
		Username:         credential.GetString("username"),
		Notes:            notes,
	})
}

func handleVaultAccessCodeRedeemAuth(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[vaultAccessCodeRedeemRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	return vaultAccessCodeRedeemCore(app, e, body, e.Auth.Id, vaultLogSourceAdmin, "")
}

// ================== P3：公开页访客兑换 ==================

const (
	vaultPublicRedeemRateLimitMax    = 10
	vaultPublicRedeemRateLimitWindow = time.Minute
)

type vaultPublicRedeemBucket struct {
	Count   int
	ResetAt time.Time
}

var (
	vaultPublicRedeemMu    sync.Mutex
	vaultPublicRedeemLimit = map[string]vaultPublicRedeemBucket{}
)

// checkVaultPublicRedeemRateLimit 按 IP 限制公开兑换尝试频率；防跨码枚举与撞码。
func checkVaultPublicRedeemRateLimit(e *core.RequestEvent) bool {
	now := time.Now()
	key := clientIP(e.Request)
	vaultPublicRedeemMu.Lock()
	defer vaultPublicRedeemMu.Unlock()
	if bucket, ok := vaultPublicRedeemLimit[key]; ok {
		if now.Before(bucket.ResetAt) {
			if bucket.Count >= vaultPublicRedeemRateLimitMax {
				return false
			}
			bucket.Count++
			vaultPublicRedeemLimit[key] = bucket
			return true
		}
	}
	vaultPublicRedeemLimit[key] = vaultPublicRedeemBucket{Count: 1, ResetAt: now.Add(vaultPublicRedeemRateLimitWindow)}
	// map 淘汰：条目超量时清一遍过期桶，避免长期运行内存泄漏。
	if len(vaultPublicRedeemLimit) > 4096 {
		for k, v := range vaultPublicRedeemLimit {
			if now.After(v.ResetAt) {
				delete(vaultPublicRedeemLimit, k)
			}
		}
	}
	return true
}

// handleVaultAccessCodeRedeemPublic 访客通过公开状态页 token 兑换授权码；未登录。
// 页面未开启账号访问时返回 404，不暴露功能存在性。
func handleVaultAccessCodeRedeemPublic(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	page, pageErr := findPublicStatusPageByToken(app, strings.TrimSpace(e.Request.PathValue("token")))
	if pageErr != nil || page == nil || !page.GetBool("vaultEnabled") {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	if !checkVaultPublicRedeemRateLimit(e) {
		return e.TooManyRequestsError(serverText(locale, "vault.publicRedeemRateLimited"), nil)
	}
	body, err := decodeStrictJSON[vaultAccessCodeRedeemRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	return vaultAccessCodeRedeemCore(app, e, body, "", vaultLogSourcePublic, page.GetString("user"))
}

// ================== P2-B：访问申请与审批 ==================

type vaultAccessRequestView struct {
	ID                 string `json:"id"`
	SubscriptionID     string `json:"subscriptionId"`
	GroupID            string `json:"groupId"`
	PublicStatusPageID string `json:"publicStatusPageId"`
	Note               string `json:"note"`
	Status             string `json:"status"`
	DecidedAt          string `json:"decidedAt"`
	CreatedAt          string `json:"createdAt"`
	CodeID             string `json:"codeId"` // 审批通过后生成的授权码 ID（可选）
}

type vaultAccessRequestCreateRequest struct {
	SubscriptionID string `json:"subscriptionId"`
	GroupID        string `json:"groupId"`
	Note           string `json:"note"`
}

type vaultAccessRequestDecideRequest struct {
	Action       string `json:"action"` // approve / decline / close
	CredentialID string `json:"credentialId"`
	Note         string `json:"note"`
	ExpireHours  int    `json:"expireHours"`
	MaxAttempts  int    `json:"maxAttempts"`
}

type vaultAccessRequestsListResponse struct {
	Requests []vaultAccessRequestView `json:"requests"`
}

func vaultAccessRequestAPIFromRecord(rec *core.Record, codeID string) vaultAccessRequestView {
	view := vaultAccessRequestView{
		ID:                 rec.Id,
		SubscriptionID:     rec.GetString("subscription"),
		GroupID:            rec.GetString("group"),
		PublicStatusPageID: rec.GetString("publicStatusPage"),
		Note:               rec.GetString("note"),
		Status:             rec.GetString("status"),
		DecidedAt:          rec.GetString("decidedAt"),
		CodeID:             codeID,
	}
	if !rec.GetDateTime("created").IsZero() {
		view.CreatedAt = rec.GetDateTime("created").Time().UTC().Format(time.RFC3339Nano)
	}
	return view
}

// handleVaultAccessRequestsList 返回归属用户下的申请（vault_access_requests.user = 当前登录用户）。
// 过滤条件直接下推到 SQLite：避免先全量拉取再做订阅归属二次校验的 N+1 查询和跨用户扫描。
// codeId 直接使用申请记录自身的 codeId 字段（审批通过时写入），不再反查 vault_access_codes 表。
func handleVaultAccessRequestsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	statusFilter := strings.TrimSpace(e.Request.URL.Query().Get("status"))
	subscriptionFilter := strings.TrimSpace(e.Request.URL.Query().Get("subscriptionId"))
	groupFilter := strings.TrimSpace(e.Request.URL.Query().Get("groupId"))
	filter := "user = {:user}"
	params := dbx.Params{"user": e.Auth.Id}
	if statusFilter != "" {
		filter += " && status = {:status}"
		params["status"] = statusFilter
	}
	if subscriptionFilter != "" {
		filter += " && subscription = {:subscription}"
		params["subscription"] = subscriptionFilter
	}
	if groupFilter != "" {
		filter += " && group = {:group}"
		params["group"] = groupFilter
	}
	all, err := app.FindRecordsByFilter("vault_access_requests", filter, "-created, -id", 0, 0, params)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	requests := make([]vaultAccessRequestView, 0, len(all))
	for _, r := range all {
		requests = append(requests, vaultAccessRequestAPIFromRecord(r, r.GetString("codeId")))
	}
	return apiSuccessJSON(e, http.StatusOK, vaultAccessRequestsListResponse{Requests: requests})
}

// 公开路由创建申请；未登录。publicStatusPage ID 来自 URL {token}。
func handleVaultAccessRequestCreatePublic(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[vaultAccessRequestCreateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	subscriptionID := strings.TrimSpace(body.SubscriptionID)
	groupID := strings.TrimSpace(body.GroupID)
	token := strings.TrimSpace(e.Request.PathValue("token"))
	// subscription 与 group 二选一非空；token 必填。
	if (subscriptionID == "" && groupID == "") || (subscriptionID != "" && groupID != "") || token == "" {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	// 公开页 URL 携带的是 bearer token（与 status 读取路由一致），必须按 token 解析页面记录；
	// 直接把 token 当记录 ID 查会导致合法申请永远 404。
	page, pageErr := findPublicStatusPageByToken(app, token)
	if pageErr != nil || page == nil {
		return e.NotFoundError(serverText(locale, "publicStatus.pageNotFound"), nil)
	}
	pageOwner := page.GetString("user")
	// 按订阅申请时校验订阅归属；按组申请时校验组归属。
	if subscriptionID != "" {
		subs, subsErr := app.FindFirstRecordByFilter(
			"subscriptions",
			"id = {:id} && user = {:user}",
			dbx.Params{"id": subscriptionID, "user": pageOwner},
		)
		if subsErr != nil || subs == nil {
			return e.NotFoundError(serverText(locale, "vault.subscriptionNotFound"), nil)
		}
	} else {
		group, groupErr := app.FindFirstRecordByFilter(
			"subscription_groups",
			"id = {:id} && user = {:user}",
			dbx.Params{"id": groupID, "user": pageOwner},
		)
		if groupErr != nil || group == nil {
			return e.NotFoundError(serverText(locale, "subscriptionGroup.notFound"), nil)
		}
	}
	if len([]rune(body.Note)) > 500 {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	collection, findErr := app.FindCollectionByNameOrId("vault_access_requests")
	if findErr != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), findErr)
	}
	record := core.NewRecord(collection)
	record.Set("user", pageOwner)
	record.Set("subscription", subscriptionID)
	record.Set("group", groupID)
	record.Set("publicStatusPage", page.Id)
	record.Set("note", body.Note)
	record.Set("status", vaultRequestStatusPending)
	record.Set("sourceIp", clientIP(e.Request))
	record.Set("userAgent", truncateVaultLogText(e.Request.UserAgent(), 300))
	if saveErr := app.Save(record); saveErr != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", saveErr), saveErr)
	}
	writeVaultAccessLog(app, pageOwner, vaultLogActionRequestSubmitted, vaultLogSourcePublic, vaultLogResultSuccess,
		subscriptionID, "", "", clientIP(e.Request), e.Request.UserAgent(), map[string]any{"requestId": record.Id, "groupId": groupID, "note": body.Note})
	return apiSuccessJSON(e, http.StatusCreated, map[string]any{"id": record.Id, "status": vaultRequestStatusPending})
}

func handleVaultAccessRequestDecide(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	reqID := strings.TrimSpace(e.Request.PathValue("id"))
	req, findErr := app.FindFirstRecordByFilter(
		"vault_access_requests",
		"id = {:id}",
		dbx.Params{"id": reqID},
	)
	if findErr != nil || req == nil {
		return e.NotFoundError(serverText(locale, "vault.requestNotFound"), findErr)
	}
	subscriptionID := req.GetString("subscription")
	requestGroupID := req.GetString("group")
	// 归属校验：申请按订阅提交时校验订阅归属；按组提交时校验组归属。
	if subscriptionID != "" {
		owned, ownerErr := app.FindFirstRecordByFilter("subscriptions", "id = {:id} && user = {:user}", dbx.Params{"id": subscriptionID, "user": e.Auth.Id})
		if ownerErr != nil || owned == nil {
			return e.NotFoundError(serverText(locale, "vault.requestNotFound"), nil)
		}
	} else {
		ownedGroup, ownerGroupErr := app.FindFirstRecordByFilter("subscription_groups", "id = {:id} && user = {:user}", dbx.Params{"id": requestGroupID, "user": e.Auth.Id})
		if ownerGroupErr != nil || ownedGroup == nil {
			return e.NotFoundError(serverText(locale, "vault.requestNotFound"), nil)
		}
	}
	body, decodeErr := decodeStrictJSON[vaultAccessRequestDecideRequest](e.Request, locale)
	if decodeErr != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", decodeErr), decodeErr)
	}
	action := strings.ToLower(strings.TrimSpace(body.Action))
	if action != "approve" && action != "decline" && action != "close" {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	status := req.GetString("status")
	if status != vaultRequestStatusPending && status != vaultRequestStatusExpired {
		return e.BadRequestError(serverText(locale, "vault.requestAlreadyDecided"), nil)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	ip := clientIP(e.Request)
	ua := e.Request.UserAgent()
	switch action {
	case "approve":
		// approve：必须指定具体 credentialId，且该凭据归属于当前用户并匹配申请的订阅。
		credential, credSubID, credErr := resolveVaultCredentialID(app, locale, e.Auth.Id, body.CredentialID)
		if credErr != nil {
			// 缺字段 / 空的情况给出更精确的文案
			if strings.TrimSpace(body.CredentialID) == "" {
				return e.BadRequestError(serverText(locale, "vault.approveCredentialRequired"), nil)
			}
			return e.BadRequestError(credErr.Error(), nil)
		}
		// 凭据匹配：订阅级账号须属于申请的订阅；组共享账号须属于申请订阅所属的组（按订阅申请），
		// 或属于申请的组本身（按组申请）。
		targetMatch := false
		if subscriptionID != "" {
			if credSubID == subscriptionID {
				targetMatch = true
			} else if ownedSub, subErr := app.FindFirstRecordByFilter("subscriptions", "id = {:id} && user = {:user}", dbx.Params{"id": subscriptionID, "user": e.Auth.Id}); subErr == nil && ownedSub != nil {
				if subGroup := ownedSub.GetString("group"); subGroup != "" && credential.GetString("group") == subGroup {
					targetMatch = true
				}
			}
		} else if requestGroupID != "" && credential.GetString("group") == requestGroupID {
			targetMatch = true
		}
		if !targetMatch {
			return e.BadRequestError(serverText(locale, "vault.credentialMismatchSubscription"), nil)
		}
		expireHours := body.ExpireHours
		if expireHours <= 0 {
			expireHours = vaultCodeExpireHoursDefault
		}
		if expireHours > vaultCodeExpireHoursMax {
			expireHours = vaultCodeExpireHoursMax
		}
		maxAttempts := body.MaxAttempts
		if maxAttempts < 1 {
			maxAttempts = vaultCodeMaxAttemptsDefault
		}
		plainCode, codeHash, codeMask, genErr := generateVaultAccessCode()
		if genErr != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), genErr)
		}
		plainCipher, encErr := encryptVaultSecret(app, plainCode)
		if encErr != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), encErr)
		}
		expiresAt := time.Now().UTC().Add(time.Duration(expireHours) * time.Hour).Format(time.RFC3339)
		codesCollection, _ := app.FindCollectionByNameOrId("vault_access_codes")
		codeRecord := core.NewRecord(codesCollection)
		codeRecord.Set("user", e.Auth.Id)
		codeRecord.Set("credential", credential.Id)
		codeRecord.Set("credentialTitle", credential.GetString("title"))
		codeRecord.Set("subscription", credSubID)
		codeRecord.Set("codeHash", codeHash)
		codeRecord.Set("plainCipher", plainCipher)
		codeRecord.Set("codeMask", codeMask)
		codeRecord.Set("request", reqID)
		codeRecord.Set("note", strings.TrimSpace(body.Note))
		codeRecord.Set("expiresAt", expiresAt)
		codeRecord.Set("maxAttempts", float64(maxAttempts))
		codeRecord.Set("attempts", 0.0)
		if saveErr := app.Save(codeRecord); saveErr != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), saveErr)
		}
		req.Set("status", vaultRequestStatusApproved)
		req.Set("decidedAt", now)
		req.Set("codeId", codeRecord.Id)
		if saveErr := app.Save(req); saveErr != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), saveErr)
		}
		writeVaultAccessLog(app, e.Auth.Id, vaultLogActionRequestApproved, vaultLogSourceAdmin, vaultLogResultSuccess,
			credSubID, credential.Id, codeRecord.Id, ip, ua, map[string]any{"requestId": reqID})
		return apiSuccessJSON(e, http.StatusOK, map[string]any{
			"id":        reqID,
			"status":    vaultRequestStatusApproved,
			"codeId":    codeRecord.Id,
			"plainCode": plainCode,
			"codeMask":  codeMask,
			"expiresAt": expiresAt,
		})
	case "decline":
		req.Set("status", vaultRequestStatusDeclined)
		req.Set("decidedAt", now)
		if saveErr := app.Save(req); saveErr != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), saveErr)
		}
		writeVaultAccessLog(app, e.Auth.Id, vaultLogActionRequestDeclined, vaultLogSourceAdmin, vaultLogResultSuccess,
			subscriptionID, "", "", ip, ua, map[string]any{"requestId": reqID})
	case "close":
		req.Set("status", vaultRequestStatusClosed)
		req.Set("decidedAt", now)
		if saveErr := app.Save(req); saveErr != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), saveErr)
		}
		writeVaultAccessLog(app, e.Auth.Id, vaultLogActionRequestClosed, vaultLogSourceAdmin, vaultLogResultSuccess,
			subscriptionID, "", "", ip, ua, map[string]any{"requestId": reqID})
	}
	return apiSuccessJSON(e, http.StatusOK, map[string]any{"id": reqID, "status": req.GetString("status")})
}

// ================== P2-C：审计日志分页查询 ==================

type vaultAccessLogView struct {
	ID             string         `json:"id"`
	Action         string         `json:"action"`
	Source         string         `json:"source"`
	Result         string         `json:"result"`
	SubscriptionID string         `json:"subscriptionId"`
	CredentialID   string         `json:"credentialId"`
	CodeID         string         `json:"codeId"`
	IP             string         `json:"ip"`
	UserAgent      string         `json:"userAgent"`
	Detail         map[string]any `json:"detail"`
	CreatedAt      string         `json:"createdAt"`
}

type vaultAccessLogsPayload struct {
	Logs     []vaultAccessLogView `json:"logs"`
	NextTime string               `json:"nextTime"` // keyset 分页游标（created, id）
	NextID   string               `json:"nextId"`
	HasMore  bool                 `json:"hasMore"`
}

type vaultAccessLogsResponse struct {
	vaultAccessLogsPayload
}

func vaultAccessLogAPIFromRecord(rec *core.Record) vaultAccessLogView {
	view := vaultAccessLogView{
		ID:             rec.Id,
		Action:         rec.GetString("action"),
		Source:         rec.GetString("source"),
		Result:         rec.GetString("result"),
		SubscriptionID: rec.GetString("subscriptionId"),
		CredentialID:   rec.GetString("credentialId"),
		CodeID:         rec.GetString("codeId"),
		IP:             rec.GetString("ip"),
		UserAgent:      rec.GetString("userAgent"),
	}
	if raw := rec.Get("detail"); raw != nil {
		if m, ok := raw.(map[string]any); ok {
			view.Detail = m
		}
	}
	if !rec.GetDateTime("created").IsZero() {
		view.CreatedAt = rec.GetDateTime("created").Time().UTC().Format(time.RFC3339Nano)
	}
	return view
}

func handleVaultAccessLogsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	q := e.Request.URL.Query()
	limit64, _ := strconv.Atoi(q.Get("limit"))
	if limit64 <= 0 {
		limit64 = 50
	}
	if limit64 > 200 {
		limit64 = 200
	}
	limit := limit64
	nextTime := strings.TrimSpace(q.Get("nextTime"))
	nextID := strings.TrimSpace(q.Get("nextId"))
	action := strings.TrimSpace(q.Get("action"))
	credentialID := strings.TrimSpace(q.Get("credentialId"))
	subscriptionID := strings.TrimSpace(q.Get("subscriptionId"))
	groupID := strings.TrimSpace(q.Get("groupId"))
	filter := "user = {:user}"
	params := dbx.Params{"user": e.Auth.Id}
	if action != "" {
		filter += " && action = {:action}"
		params["action"] = action
	}
	if credentialID != "" {
		filter += " && credentialId = {:credentialId}"
		params["credentialId"] = credentialID
	}
	if subscriptionID != "" {
		filter += " && subscriptionId = {:subscriptionId}"
		params["subscriptionId"] = subscriptionID
	}
	if groupID != "" {
		filter += " && groupId = {:groupId}"
		params["groupId"] = groupID
	}
	// keyset 分页：按 (created DESC, id DESC)
	sort := "-created, -id"
	if nextTime != "" {
		if _, parseErr := time.Parse(time.RFC3339Nano, nextTime); parseErr == nil {
			filter += " && (created < {:next} || (created = {:next} && id < {:nextId}))"
			params["next"] = nextTime
			params["nextId"] = nextID
		}
	}
	records, err := app.FindRecordsByFilter("vault_access_logs", filter, sort, limit+1, 0, params)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	hasMore := len(records) > limit
	if hasMore {
		records = records[:limit]
	}
	logs := make([]vaultAccessLogView, 0, len(records))
	for _, rec := range records {
		logs = append(logs, vaultAccessLogAPIFromRecord(rec))
	}
	payload := vaultAccessLogsPayload{Logs: logs, HasMore: hasMore}
	if hasMore && len(records) > 0 {
		last := records[len(records)-1]
		if !last.GetDateTime("created").IsZero() {
			payload.NextTime = last.GetDateTime("created").Time().UTC().Format(time.RFC3339Nano)
		}
		payload.NextID = last.Id
	}
	return apiSuccessJSON(e, http.StatusOK, vaultAccessLogsResponse{vaultAccessLogsPayload: payload})
}
