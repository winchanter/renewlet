package main

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// vault_schema.go 收敛账号库（Credential Vault）collection。
//
// 架构位置：
//   - vault_credentials 保存凭据标题/用户名/URL 明文与密码、备注的 AES-GCM 密文，
//     敏感字段只经 /api/app/vault 路由加解密，PocketBase REST 只能按 owner 规则触达密文。
//   - vault_access_codes / vault_access_requests 是一次性验证码与公开页申请的宿主表（P2/P3 启用），
//     保存码 hash 与申请状态，不允许 REST 直写。
//   - vault_access_logs 记录 reveal/解锁等审计事件，owner 只读，写入只来自服务端。
func ensureVaultCollections(app core.App, users *core.Collection) error {
	subscriptions, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		return err
	}
	// 先收敛 vault_credentials：全新库首次运行时它还不存在，不能在创建前预查询。
	if err := ensureVaultCredentialsCollection(app, users, subscriptions); err != nil {
		return err
	}
	vaultCredentials, err := app.FindCollectionByNameOrId("vault_credentials")
	if err != nil {
		return err
	}
	if err := ensureVaultAccessCodesCollection(app, users, vaultCredentials); err != nil {
		return err
	}
	if err := ensureVaultAccessRequestsCollection(app, users); err != nil {
		return err
	}
	return ensureVaultAccessLogsCollection(app, users)
}

func ensureVaultCredentialsCollection(app core.App, users *core.Collection, subscriptions *core.Collection) error {
	return ensureCollection(app, "vault_credentials", func(c *core.Collection) error {
		ownerRules(c)
		minZero := 0.0
		fields := []core.Field{
			userRelation(users),
			// 订阅删除时凭据固定保留为独立账号：relation 不级联，PocketBase 会自动把引用置空。
			&core.RelationField{Name: "subscription", CollectionId: subscriptions.Id, MaxSelect: 1},
			&core.TextField{Name: "title", Required: true, Max: 120},
			&core.TextField{Name: "url", Max: maxLogoReferenceLength},
			&core.TextField{Name: "username", Max: 200},
			// 密码/备注只存密文（v1.nonce.ciphertext，AES-256-GCM，密钥来自账号安全密钥环 vault 用途域）。
			&core.TextField{Name: "passwordCiphertext", Max: 8192},
			&core.TextField{Name: "notesCiphertext", Max: 20480},
			&core.NumberField{Name: "sortOrder", OnlyInt: true, Min: &minZero},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_vault_credentials_user", false, "user", "")
		c.AddIndex("idx_vault_credentials_user_subscription", false, "user, subscription", "")
		return nil
	})
}

func ensureVaultAccessCodesCollection(app core.App, users *core.Collection, vaultCredentials *core.Collection) error {
	return ensureCollection(app, "vault_access_codes", func(c *core.Collection) error {
		// 验证码保存 SHA-256 hash（兑换点查）+ 加密明文存档（管理员可重复查阅）；REST 不开放任何直写规则。
		secretCollectionRules(c)
		minZero := 0.0
		fields := []core.Field{
			userRelation(users),
			// credential 必填绑定单个账号；凭据删除后保留码的审计视图（Relation 不级联，PB 自动置空，但 handler 会校验存在性）。
			&core.RelationField{Name: "credential", CollectionId: vaultCredentials.Id, MaxSelect: 1},
			// subscription 文本快照冗余（可为空，用于独立账号），订阅删除后历史码仍能展示归属。
			&core.TextField{Name: "subscription", Max: 128},
			// credentialTitle 文本快照冗余：凭据改名后历史码列表不会漂移。
			&core.TextField{Name: "credentialTitle", Required: true, Max: 120},
			&core.TextField{Name: "codeHash", Required: true, Max: 128, Pattern: `^[a-f0-9]{64}$`},
			// plainCipher 明文加密存档（v1.nonce.ciphertext，vault 用途域）；旧版 hash-only 码允许为空。
			&core.TextField{Name: "plainCipher", Max: 400},
			&core.TextField{Name: "codeMask", Max: 16},
			&core.TextField{Name: "request", Max: 128},
			&core.TextField{Name: "note", Max: 500},
			&core.TextField{Name: "expiresAt", Required: true, Max: 40},
			&core.NumberField{Name: "maxAttempts", OnlyInt: true, Min: types.Pointer(1.0)},
			&core.NumberField{Name: "attempts", OnlyInt: true, Min: &minZero},
			&core.TextField{Name: "usedAt", Max: 40},
			&core.TextField{Name: "revokedAt", Max: 40},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		// codeHash 唯一索引同时承担公开 unlock 的点查与防重放语义。
		c.AddIndex("idx_vault_access_codes_code_hash_unique", true, "codeHash", "")
		c.AddIndex("idx_vault_access_codes_user", false, "user", "")
		c.AddIndex("idx_vault_access_codes_user_credential", false, "user, credential", "")
		return nil
	})
}

func ensureVaultAccessRequestsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "vault_access_requests", func(c *core.Collection) error {
		// 申请由公开 route 创建、管理员 route 决策；状态机不允许 REST 直写。
		secretCollectionRules(c)
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "subscription", Required: true, Max: 128},
			&core.TextField{Name: "publicStatusPage", Required: true, Max: 128},
			&core.TextField{Name: "note", Max: 500},
			&core.SelectField{Name: "status", Required: true, Values: []string{"pending", "approved", "declined", "expired", "closed"}},
			&core.TextField{Name: "sourceIp", Max: 64},
			&core.TextField{Name: "userAgent", Max: 300},
			&core.TextField{Name: "decidedAt", Max: 40},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_vault_access_requests_user_status", false, "user, status, created", "")
		c.AddIndex("idx_vault_access_requests_user_subscription", false, "user, subscription", "")
		return nil
	})
}

func ensureVaultAccessLogsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "vault_access_logs", func(c *core.Collection) error {
		// 审计日志 owner 只读；写入只能来自服务端 route，防止 REST 伪造记录。
		ownerReadRule := "user = @request.auth.id && @request.auth.banned = false"
		c.ListRule = types.Pointer(ownerReadRule)
		c.ViewRule = types.Pointer(ownerReadRule)
		c.CreateRule = nil
		c.UpdateRule = nil
		c.DeleteRule = nil
	fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "action", Required: true, Max: 40},
			&core.SelectField{Name: "source", Required: true, Values: []string{"admin", "public"}},
			&core.SelectField{Name: "result", Required: true, Values: []string{"success", "failure"}},
			// 关联对象用文本快照：订阅/凭据删除后日志必须保持可读。
			&core.TextField{Name: "subscriptionId", Max: 128},
			&core.TextField{Name: "credentialId", Max: 128},
			&core.TextField{Name: "codeId", Max: 128},
			&core.TextField{Name: "ip", Max: 64},
			&core.TextField{Name: "userAgent", Max: 300},
			&core.JSONField{Name: "detail", MaxSize: 4096},
		}
		for _, field := range fields {
			if err := upsertField(c, field); err != nil {
				return err
			}
		}
		if err := ensureAutodates(c); err != nil {
			return err
		}
		c.AddIndex("idx_vault_access_logs_user_created", false, "user, created, id", "")
		c.AddIndex("idx_vault_access_logs_user_action", false, "user, action, created", "")
		return nil
	})
}
