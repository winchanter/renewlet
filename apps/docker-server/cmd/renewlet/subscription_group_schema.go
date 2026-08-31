package main

// subscription_group_schema.go 维护订阅组（Subscription Group）collection。
//
// 架构位置：
//   - subscription_groups 表示"同一个大服务下的多个订阅"（如 AWS 多账号、Netflix 家庭组），
//     与 subscriptions.category（粗分类文本）并存：category 是筛选维度，group 是具体大服务实体。
//   - subscriptions.group 是可选 relation，删除组时订阅保留（relation 不级联，PocketBase 自动置空）。
//   - vault_credentials.group 是可选 relation，支持组级共享账号；与 subscription relation 互斥（服务端校验）。
//
// 注意： 组删除不级联到订阅/凭据，只把它们的 group 字段置空；组本身是独立实体。

import (
	"errors"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func ensureSubscriptionGroupsCollection(app core.App, users *core.Collection) error {
	return ensureCollection(app, "subscription_groups", func(c *core.Collection) error {
		ownerRules(c)
		minZero := 0.0
		fields := []core.Field{
			userRelation(users),
			&core.TextField{Name: "name", Required: true, Max: 120},
			// logo 复用订阅 logo 同款引用字段（私有资产路径或 http(s) 外链）。
			&core.TextField{Name: "logo", Max: maxLogoReferenceLength},
			&core.TextField{Name: "description", Max: 500},
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
		c.AddIndex("idx_subscription_groups_user_order", false, "user, sortOrder, created, id", "")
		return nil
	})
}

// subscriptionGroupRelationField 返回指向 subscription_groups 的可选 relation 字段。
// 不级联删除：组删除时引用方保留，PocketBase 自动把 relation 置空。
func subscriptionGroupRelationField(groups *core.Collection) *core.RelationField {
	return &core.RelationField{
		Name:         "group",
		CollectionId: groups.Id,
		MaxSelect:    1,
		// 不设 Required，允许未分组；不设 CascadeDelete，组删除时订阅/凭据保留。
	}
}

// resolveSubscriptionGroupID 校验关联组归属；返回空串表示未绑定组。
// 同时返回组的 name 快照，用于访问申请/授权码等文本冗余场景。
func resolveSubscriptionGroupID(app core.App, locale appLocale, userID, groupID string) (string, string, error) {
	groupID = strings.TrimSpace(groupID)
	if groupID == "" {
		return "", "", nil
	}
	record, err := app.FindFirstRecordByFilter(
		"subscription_groups",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": groupID, "user": userID},
	)
	if err != nil || record == nil {
		return "", "", errors.New(serverText(locale, "subscriptionGroup.notFound"))
	}
	return groupID, record.GetString("name"), nil
}

// validateSubscriptionWriteGroup 校验订阅写入请求的 groupId 归属。
// Set=false 表示未传，跳过；Null=true 表示显式清空，合法；Value 非空时校验归属。
func validateSubscriptionWriteGroup(app core.App, locale appLocale, userID string, field optionalJSONField[string]) error {
	if !field.Set || field.Null {
		return nil
	}
	if _, _, err := resolveSubscriptionGroupID(app, locale, userID, field.Value); err != nil {
		return err
	}
	return nil
}
