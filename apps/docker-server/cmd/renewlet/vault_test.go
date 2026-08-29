package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// vault_test.go 保护账号库核心安全语义：
//   - 密码/备注只存密文，任何列表/详情响应都不得出现明文密码；
//   - 明文只经显式 reveal 返回，且每次 reveal 落审计日志；
//   - 归属边界（跨用户 404）与订阅删除后的"保留为独立账号"语义。
func createVaultTestSubscription(t *testing.T, app core.App, userID string, name string) *core.Record {
	t.Helper()
	return createCalendarFeedTestSubscription(t, app, userID, calendarFeedTestSubscription{
		Name:            name,
		Price:           "12",
		BillingCycle:    "monthly",
		Category:        "developer_tools",
		Status:          "active",
		NextBillingDate: "2099-06-01",
	})
}

func TestVaultCredentialLifecycleAndAudit(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "vault")

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/vault/credentials", `{
		"title": "Admin Panel",
		"url": "https://panel.example.test",
		"username": "admin",
		"password": "s3cret-pass",
		"notes": "rotated quarterly"
	}`, token)
	if createRes.Code != http.StatusCreated {
		t.Fatalf("expected credential create 201, got %d: %s", createRes.Code, createRes.Body.String())
	}
	created := decodeAPISuccessDataForTest[vaultCredentialView](t, createRes.Body.Bytes())
	if created.ID == "" || created.Title != "Admin Panel" || !created.HasPassword || created.Notes != "rotated quarterly" {
		t.Fatalf("unexpected create response: %#v", created)
	}
	// 密码明文不得出现在任何成功响应里；密文 v1.nonce.ciphertext 也只存数据库。
	if strings.Contains(createRes.Body.String(), "s3cret-pass") {
		t.Fatalf("create response leaked plaintext password: %s", createRes.Body.String())
	}

	listRes := serveTestRequest(t, app, http.MethodGet, "/api/app/vault/credentials", "", token)
	if listRes.Code != http.StatusOK {
		t.Fatalf("expected credentials list 200, got %d: %s", listRes.Code, listRes.Body.String())
	}
	list := decodeAPISuccessDataForTest[vaultCredentialsListResponse](t, listRes.Body.Bytes())
	if len(list.Credentials) != 1 || list.Credentials[0].ID != created.ID || !list.Credentials[0].HasPassword {
		t.Fatalf("unexpected list response: %#v", list.Credentials)
	}

	// PATCH：改名 + 显式 null 清除密码；缺省字段（url/username/notes）必须保持不变。
	patchRes := serveTestRequest(t, app, http.MethodPatch, "/api/app/vault/credentials/"+created.ID, `{
		"title": "Renamed Panel",
		"password": null
	}`, token)
	if patchRes.Code != http.StatusOK {
		t.Fatalf("expected credential patch 200, got %d: %s", patchRes.Code, patchRes.Body.String())
	}
	patched := decodeAPISuccessDataForTest[vaultCredentialView](t, patchRes.Body.Bytes())
	if patched.Title != "Renamed Panel" || patched.HasPassword || patched.Username != "admin" || patched.Notes != "rotated quarterly" {
		t.Fatalf("unexpected patch response: %#v", patched)
	}

	// PATCH：重新设置密码后 reveal 返回明文。
	if res := serveTestRequest(t, app, http.MethodPatch, "/api/app/vault/credentials/"+created.ID, `{"password":"new-pass"}`, token); res.Code != http.StatusOK {
		t.Fatalf("expected password re-set 200, got %d: %s", res.Code, res.Body.String())
	}
	revealRes := serveTestRequest(t, app, http.MethodPost, "/api/app/vault/credentials/"+created.ID+"/reveal", "", token)
	if revealRes.Code != http.StatusOK {
		t.Fatalf("expected reveal 200, got %d: %s", revealRes.Code, revealRes.Body.String())
	}
	if strings.Contains(revealRes.Body.String(), "s3cret-pass") {
		t.Fatalf("reveal returned the cleared password: %s", revealRes.Body.String())
	}
	revealed := decodeAPISuccessDataForTest[vaultCredentialRevealResponse](t, revealRes.Body.Bytes())
	if revealed.Password != "new-pass" {
		t.Fatalf("unexpected reveal password: %#v", revealed)
	}

	// 审计链：created/updated/viewed 至少各一条，且关联当前凭据。
	logs, err := app.FindAllRecords("vault_access_logs", dbx.HashExp{"user": user.Id})
	if err != nil {
		t.Fatal(err)
	}
	actions := map[string]int{}
	for _, log := range logs {
		actions[log.GetString("action")]++
		if log.GetString("credentialId") != created.ID {
			t.Fatalf("audit log %s points to unexpected credential %q", log.GetString("action"), log.GetString("credentialId"))
		}
	}
	for _, action := range []string{"credential_created", "credential_updated", "credential_viewed"} {
		if actions[action] == 0 {
			t.Fatalf("expected audit log action %q, got %#v", action, actions)
		}
	}

	deleteRes := serveTestRequest(t, app, http.MethodDelete, "/api/app/vault/credentials/"+created.ID, "", token)
	if deleteRes.Code != http.StatusOK {
		t.Fatalf("expected credential delete 200, got %d: %s", deleteRes.Code, deleteRes.Body.String())
	}
	emptyList := decodeAPISuccessDataForTest[vaultCredentialsListResponse](t,
		serveTestRequest(t, app, http.MethodGet, "/api/app/vault/credentials", "", token).Body.Bytes())
	if len(emptyList.Credentials) != 0 {
		t.Fatalf("expected empty credentials after delete, got %#v", emptyList.Credentials)
	}
	if res := serveTestRequest(t, app, http.MethodPost, "/api/app/vault/credentials/"+created.ID+"/reveal", "", token); res.Code != http.StatusNotFound {
		t.Fatalf("expected reveal on deleted credential 404, got %d: %s", res.Code, res.Body.String())
	}
}

func TestVaultCredentialOwnershipAndSubscriptionUnlink(t *testing.T) {
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, "vault-owner")
	subscription := createVaultTestSubscription(t, app, user.Id, "Owned Plan")

	createRes := serveTestRequest(t, app, http.MethodPost, "/api/app/vault/credentials", `{
		"title": "Bound Credential",
		"subscriptionId": "`+subscription.Id+`",
		"password": "bound-pass"
	}`, token)
	if createRes.Code != http.StatusCreated {
		t.Fatalf("expected bound credential create 201, got %d: %s", createRes.Code, createRes.Body.String())
	}
	created := decodeAPISuccessDataForTest[vaultCredentialView](t, createRes.Body.Bytes())
	if created.SubscriptionID != subscription.Id {
		t.Fatalf("expected subscription binding, got %#v", created)
	}

	// 跨用户归属：其他用户的 token 不能读取/修改/删除/揭示本用户的凭据。
	other, otherToken := createRouteTestUser(t, app, "vault-other")
	_ = other
	for _, req := range []struct {
		method string
		target string
		body   string
	}{
		{http.MethodGet, "/api/app/vault/credentials/" + created.ID, ""},
		{http.MethodPatch, "/api/app/vault/credentials/" + created.ID, `{"title":"hijack"}`},
		{http.MethodDelete, "/api/app/vault/credentials/" + created.ID, ""},
		{http.MethodPost, "/api/app/vault/credentials/" + created.ID + "/reveal", ""},
	} {
		res := serveTestRequest(t, app, req.method, req.target, req.body, otherToken)
		if res.Code != http.StatusNotFound {
			t.Fatalf("expected %s %s to return 404 for foreign credential, got %d: %s", req.method, req.target, res.Code, res.Body.String())
		}
	}

	// 订阅删除后凭据固定保留为独立账号，subscriptionId 置空。
	if err := app.Delete(subscription); err != nil {
		t.Fatal(err)
	}
	list := decodeAPISuccessDataForTest[vaultCredentialsListResponse](t,
		serveTestRequest(t, app, http.MethodGet, "/api/app/vault/credentials", "", token).Body.Bytes())
	if len(list.Credentials) != 1 || list.Credentials[0].SubscriptionID != "" || list.Credentials[0].Title != "Bound Credential" {
		t.Fatalf("expected credential to survive subscription deletion as standalone, got %#v", list.Credentials)
	}

	// 不存在的订阅引用必须被拒绝。
	badSubRes := serveTestRequest(t, app, http.MethodPost, "/api/app/vault/credentials", `{
		"title": "Bad Binding",
		"subscriptionId": "missing-subscription"
	}`, token)
	if badSubRes.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid subscription binding rejection, got %d: %s", badSubRes.Code, badSubRes.Body.String())
	}

	// 空 title 创建必须被拒绝。
	emptyTitleRes := serveTestRequest(t, app, http.MethodPost, "/api/app/vault/credentials", `{"title":"   "}`, token)
	if emptyTitleRes.Code != http.StatusBadRequest {
		t.Fatalf("expected empty title rejection, got %d: %s", emptyTitleRes.Code, emptyTitleRes.Body.String())
	}
}
