package main

// vault.go 承载账号库（Credential Vault）的产品 API。
//
// 架构位置：
//   - 密码与备注只在服务端经账号安全密钥环的 vault 用途域加解密；列表/详情响应永不携带密文，
//     明文密码仅通过显式 reveal 动作返回并写审计日志。
//   - 归属边界与订阅路由一致：查询同时带 id 和 user，避免通过错误码枚举他人凭据。
import (
	"errors"
	"net/http"
	"strings"
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
	vaultLogSourceAdmin             = "admin"
	vaultLogResultSuccess           = "success"
)

type vaultCredentialView struct {
	ID             string `json:"id"`
	SubscriptionID string `json:"subscriptionId"`
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
	Title          string `json:"title"`
	URL            string `json:"url"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	Notes          string `json:"notes"`
}

// vaultCredentialUpdateRequest 区分缺字段、显式 null 与空串：null 清空，缺省保持不变，密码不 trim。
type vaultCredentialUpdateRequest struct {
	SubscriptionID optionalJSONField[string] `json:"subscriptionId"`
	Title          optionalJSONField[string] `json:"title"`
	URL            optionalJSONField[string] `json:"url"`
	Username       optionalJSONField[string] `json:"username"`
	Password       optionalJSONField[string] `json:"password"`
	Notes          optionalJSONField[string] `json:"notes"`
}

func (r vaultCredentialUpdateRequest) HasChanges() bool {
	return r.SubscriptionID.Set || r.Title.Set || r.URL.Set || r.Username.Set ||
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
	filter := "user = {:user}"
	params := dbx.Params{"user": e.Auth.Id}
	if subscriptionFilter != "" {
		filter += " && subscription = {:subscription}"
		params["subscription"] = subscriptionFilter
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
