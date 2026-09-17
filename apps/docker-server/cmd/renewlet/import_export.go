package main

// import_export.go 实现 Renewo/Wallos 导入预览与执行。
//
// 架构位置：
//   - 前端先在浏览器本地解析文件，再把标准 importPayload 交给这里做用户隔离、冲突预览和写库。
//   - extra.import 是跨 Go/PocketBase、Cloudflare Worker 与前端 shared schema 的幂等键事实来源。
//   - apply 会重新 preview 并在事务内写 subscriptions/settings/custom_configs，避免 UI 预览被篡改后直接落库。
//
// 注意： 预览上限服务于冲突分析，执行上限服务于真实写库成本；两者不要合并成一个魔法数字。

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const maxImportJSONBodyBytes int64 = 8 << 20
const maxImportPreviewSubscriptions = 1000
const maxImportApplySubscriptions = 200

// 与 shared IMPORT_GROUPS_LIMIT/IMPORT_BILLING_RECORDS_LIMIT 对齐。
const maxImportGroups = 100
const maxImportBillingRecords = 2000
const importWarningLowConfidenceKey = "IMPORT_WARNING_LOW_CONFIDENCE_KEY"
const importWarningLowConfidenceNameMatched = "IMPORT_WARNING_LOW_CONFIDENCE_NAME_MATCHED"

type importPreviewRequest struct {
	Payload             importPayload `json:"payload"`
	ConflictMode        string        `json:"conflictMode"`
	SkipIndexes         []int         `json:"skipIndexes,omitempty"`
	ForceReplaceIndexes []int         `json:"forceReplaceIndexes,omitempty"`
}

type importApplyRequest struct {
	Payload             importPayload `json:"payload"`
	ConflictMode        string        `json:"conflictMode"`
	SkipIndexes         []int         `json:"skipIndexes,omitempty"`
	ForceReplaceIndexes []int         `json:"forceReplaceIndexes,omitempty"`
}

type importPayload struct {
	Source                string                    `json:"source"`
	Subscriptions         []importSubscription      `json:"subscriptions"`
	Settings              json.RawMessage           `json:"settings,omitempty"`
	CustomConfig          *customConfigPayload      `json:"customConfig,omitempty"`
	ExchangeRateSnapshots []exchangeRateSnapshotDTO `json:"exchangeRateSnapshots,omitempty"`
	Groups                []importGroup             `json:"groups,omitempty"`
	BillingRecords        []billingRecordItem       `json:"billingRecords,omitempty"`
}

// importGroup 是恢复包内的分组形状；ID 为源实例分组 ID，apply 时重建为新 ID 并映射订阅归属。
type importGroup struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Logo        *string `json:"logo,omitempty"`
	Description *string `json:"description,omitempty"`
	SortOrder   int     `json:"sortOrder"`
}

type importSubscription struct {
	Name                         string                 `json:"name"`
	Logo                         *string                `json:"logo,omitempty"`
	Price                        string                 `json:"price"`
	Currency                     string                 `json:"currency"`
	BillingCycle                 string                 `json:"billingCycle"`
	CustomDays                   *int                   `json:"customDays,omitempty"`
	CustomCycleUnit              *string                `json:"customCycleUnit,omitempty"`
	OneTimeTermCount             *int                   `json:"oneTimeTermCount,omitempty"`
	OneTimeTermUnit              *string                `json:"oneTimeTermUnit,omitempty"`
	UsageUnit                    *string                `json:"usageUnit,omitempty"`
	UsageTotal                   *float64               `json:"usageTotal,omitempty"`
	UsageDailyRate               *float64               `json:"usageDailyRate,omitempty"`
	UsageExpiresAt               *string                `json:"usageExpiresAt,omitempty"`
	Category                     string                 `json:"category"`
	Status                       string                 `json:"status"`
	Pinned                       bool                   `json:"pinned"`
	PublicHidden                 bool                   `json:"publicHidden"`
	PaymentMethod                *string                `json:"paymentMethod,omitempty"`
	StartDate                    *string                `json:"startDate"`
	NextBillingDate              string                 `json:"nextBillingDate"`
	AutoRenew                    bool                   `json:"autoRenew"`
	AutoCalculateNextBillingDate bool                   `json:"autoCalculateNextBillingDate"`
	TrialEndDate                 *string                `json:"trialEndDate,omitempty"`
	Website                      *string                `json:"website,omitempty"`
	Notes                        *string                `json:"notes,omitempty"`
	Tags                         []string               `json:"tags,omitempty"`
	ReminderDays                 int                    `json:"reminderDays"`
	RepeatReminderEnabled        bool                   `json:"repeatReminderEnabled"`
	RepeatReminderInterval       string                 `json:"repeatReminderInterval"`
	RepeatReminderWindow         string                 `json:"repeatReminderWindow"`
	CostSharing                  map[string]interface{} `json:"costSharing,omitempty"`
	// GroupID 引用恢复包内的源分组 ID；apply 时先重建分组再映射到新实例 ID，nil/缺失表示未分组。
	GroupID *string                `json:"groupId,omitempty"`
	Extra   map[string]interface{} `json:"extra"`
}

type importPreviewResponse struct {
	Summary                       importSummary       `json:"summary"`
	Items                         []importPreviewItem `json:"items"`
	IncludesSettings              bool                `json:"includesSettings"`
	IncludesCustomConfig          bool                `json:"includesCustomConfig"`
	IncludesExchangeRateSnapshots bool                `json:"includesExchangeRateSnapshots"`
	ExchangeRateSnapshotsCount    int                 `json:"exchangeRateSnapshotsCount"`
	IncludesGroups                bool                `json:"includesGroups"`
	GroupsCount                   int                 `json:"groupsCount"`
	IncludesBillingRecords        bool                `json:"includesBillingRecords"`
	BillingRecordsCount           int                 `json:"billingRecordsCount"`
}

type importApplyResponse struct {
	importPreviewResponse
}

type importPreviewItem struct {
	Index      int      `json:"index"`
	Name       string   `json:"name"`
	Source     string   `json:"source"`
	SourceID   string   `json:"sourceId"`
	ExistingID string   `json:"existingId,omitempty"`
	Action     string   `json:"action"`
	Warnings   []string `json:"warnings"`
	Errors     []string `json:"errors"`
}

type importSummary struct {
	Total    int `json:"total"`
	Creates  int `json:"creates"`
	Replaces int `json:"replaces"`
	Skips    int `json:"skips"`
	Errors   int `json:"errors"`
	Warnings int `json:"warnings"`
}

type importKey struct {
	Source     string
	SourceID   string
	Confidence string
}

type importExistingMatches struct {
	ByKey                   map[string]*core.Record
	LowConfidenceByName     map[string]*core.Record
	LowConfidenceDuplicates map[string]bool
}

func (r *importPreviewRequest) Validate(locale appLocale) error {
	return validateImportPayload(r.Payload, r.ConflictMode, r.SkipIndexes, r.ForceReplaceIndexes, maxImportPreviewSubscriptions, locale)
}

func (r *importApplyRequest) Validate(locale appLocale) error {
	return validateImportPayload(r.Payload, r.ConflictMode, r.SkipIndexes, r.ForceReplaceIndexes, maxImportApplySubscriptions, locale)
}

func handleImportPreview(app core.App, e *core.RequestEvent) error {
	startedAt := time.Now()
	itemCount := 0
	defer func() {
		slog.Info("import preview resources",
			"body_bytes", e.Request.ContentLength,
			"items", itemCount,
			"duration", time.Since(startedAt),
		)
	}()
	locale := requestLocale(e.Request)
	// 导入请求在完整解析前限制为 8 MiB，避免同时持有大 body、现有订阅和预览结果。
	body, err := decodeStrictJSONWithLimit[importPreviewRequest](e.Request, locale, maxImportJSONBodyBytes)
	if err != nil {
		if isImportTooLargeError(err) {
			return apiErrorJSON(e, http.StatusRequestEntityTooLarge, "IMPORT_TOO_LARGE", serverText(locale, "import.invalid"), nil)
		}
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := body.Validate(locale); err != nil {
		if isImportTooLargeError(err) {
			return apiErrorJSON(e, http.StatusRequestEntityTooLarge, "IMPORT_TOO_LARGE", serverText(locale, "import.invalid"), nil)
		}
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidPayload", err), err)
	}
	itemCount = len(body.Payload.Subscriptions)
	response, err := previewImportPayload(app, e.Auth, body.Payload, body.ConflictMode, body.SkipIndexes, body.ForceReplaceIndexes)
	if err != nil {
		return e.BadRequestError(serverText(locale, "import.invalid"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, response)
}

func handleImportApply(app core.App, e *core.RequestEvent) error {
	startedAt := time.Now()
	itemCount := 0
	defer func() {
		slog.Info("import apply resources",
			"body_bytes", e.Request.ContentLength,
			"items", itemCount,
			"duration", time.Since(startedAt),
		)
	}()
	locale := requestLocale(e.Request)
	// apply 会重新预览再进事务，防止调用方篡改 preview 结果后直接写库。
	body, err := decodeStrictJSONWithLimit[importApplyRequest](e.Request, locale, maxImportJSONBodyBytes)
	if err != nil {
		if isImportTooLargeError(err) {
			return apiErrorJSON(e, http.StatusRequestEntityTooLarge, "IMPORT_TOO_LARGE", serverText(locale, "import.invalid"), nil)
		}
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	if err := body.Validate(locale); err != nil {
		if isImportTooLargeError(err) {
			return apiErrorJSON(e, http.StatusRequestEntityTooLarge, "IMPORT_TOO_LARGE", serverText(locale, "import.invalid"), nil)
		}
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidPayload", err), err)
	}
	itemCount = len(body.Payload.Subscriptions)
	preview, err := previewImportPayload(app, e.Auth, body.Payload, body.ConflictMode, body.SkipIndexes, body.ForceReplaceIndexes)
	if err != nil {
		return e.BadRequestError(serverText(locale, "import.invalid"), err)
	}
	if preview.Summary.Errors > 0 {
		return e.BadRequestError(serverText(locale, "import.payloadContainsErrors"), preview)
	}
	if err := applyImportPayload(app, e.Auth, body.Payload, body.ConflictMode, body.SkipIndexes, body.ForceReplaceIndexes); err != nil {
		return e.BadRequestError(serverText(locale, "import.applyFailed"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, importApplyResponse{importPreviewResponse: preview})
}

func isImportTooLargeError(err error) bool {
	message := err.Error()
	return strings.Contains(message, "body too large") || strings.Contains(message, "IMPORT_TOO_MANY_SUBSCRIPTIONS")
}

func validateImportPayload(payload importPayload, conflictMode string, skipIndexes []int, forceReplaceIndexes []int, maxSubscriptions int, _ appLocale) error {
	if conflictMode != "replace" && conflictMode != "skip" {
		return errors.New("IMPORT_CONFLICT_MODE_INVALID")
	}
	if payload.Source != "renewlet" && payload.Source != "wallos" && payload.Source != "ai" {
		return errors.New("IMPORT_SOURCE_INVALID")
	}
	if len(payload.Subscriptions) > maxSubscriptions {
		return errors.New("IMPORT_TOO_MANY_SUBSCRIPTIONS")
	}
	if len(payload.ExchangeRateSnapshots) > maxExchangeRateSnapshotsPerUser {
		return errors.New("IMPORT_TOO_MANY_EXCHANGE_RATE_SNAPSHOTS")
	}
	if len(payload.ExchangeRateSnapshots) > 0 && payload.Source != "renewlet" {
		return errors.New("IMPORT_EXCHANGE_RATE_SNAPSHOTS_SOURCE_INVALID")
	}
	if len(payload.Groups) > maxImportGroups {
		return errors.New("IMPORT_TOO_MANY_GROUPS")
	}
	if len(payload.BillingRecords) > maxImportBillingRecords {
		return errors.New("IMPORT_TOO_MANY_BILLING_RECORDS")
	}
	// 分组与续订流水是 Renewo 自导出独有的用户事实；Wallos/AI 导入永远不会带这两段，
	// 放行会让外部 payload 借恢复入口写入不可变流水。
	if (len(payload.Groups) > 0 || len(payload.BillingRecords) > 0) && payload.Source != "renewlet" {
		return errors.New("IMPORT_GROUPS_BILLING_RECORDS_SOURCE_INVALID")
	}
	// skipIndexes 边界校验 + forceReplaceIndexes 边界 + 互斥校验。
	subCount := len(payload.Subscriptions)
	for _, idx := range skipIndexes {
		if idx < 0 || idx >= subCount {
			return errors.New("IMPORT_SKIP_INDEX_INVALID")
		}
	}
	skipSet := make(map[int]bool, len(skipIndexes))
	for _, idx := range skipIndexes {
		skipSet[idx] = true
	}
	for _, idx := range forceReplaceIndexes {
		if idx < 0 || idx >= subCount {
			return errors.New("IMPORT_FORCE_REPLACE_INDEX_INVALID")
		}
		if skipSet[idx] {
			return errors.New("IMPORT_INDEX_IN_BOTH_SKIP_AND_FORCE_REPLACE")
		}
	}
	seenGroupIDs := map[string]bool{}
	for index, group := range payload.Groups {
		groupID := strings.TrimSpace(group.ID)
		if groupID == "" {
			return fmt.Errorf("groups %d: IMPORT_GROUP_ID_INVALID", index+1)
		}
		if seenGroupIDs[groupID] {
			return fmt.Errorf("groups %d: IMPORT_GROUP_ID_DUPLICATE", index+1)
		}
		seenGroupIDs[groupID] = true
		if strings.TrimSpace(group.Name) == "" {
			return fmt.Errorf("groups %d: IMPORT_GROUP_NAME_REQUIRED", index+1)
		}
	}
	for index, record := range payload.BillingRecords {
		// 凭证数量与空值边界与续订写入契约（api_contracts.go）保持一致，恢复入口不能放宽。
		if len(record.ReceiptAssetIds) > 6 {
			return fmt.Errorf("billingRecords %d: BILLING_RECORD_RECEIPT_ASSET_IDS_INVALID", index+1)
		}
		for _, assetID := range record.ReceiptAssetIds {
			if strings.TrimSpace(assetID) == "" {
				return fmt.Errorf("billingRecords %d: BILLING_RECORD_RECEIPT_ASSET_IDS_INVALID", index+1)
			}
		}
		// 目标订阅 ID 在 apply 阶段才能按映射确定；预览阶段用占位值只做事实字段校验。
		input := billingRecordUpsertFromImport("_", strings.TrimSpace(record.SubscriptionID), record)
		if err := validateBillingRecordUpsert(input); err != nil {
			return fmt.Errorf("billingRecords %d: %w", index+1, err)
		}
	}
	if _, err := importSkippedIndexSet(skipIndexes, len(payload.Subscriptions)); err != nil {
		return err
	}
	if rawJSONIsNull(payload.Settings) {
		return errors.New("IMPORT_SETTINGS_INVALID")
	}
	for i := range payload.Subscriptions {
		key, err := importKeyFromExtra(payload.Subscriptions[i].Extra)
		if err != nil {
			return fmt.Errorf("subscription %d: %w", i+1, err)
		}
		if key.Source != payload.Source {
			return fmt.Errorf("subscription %d: IMPORT_SOURCE_MISMATCH", i+1)
		}
	}
	if payload.CustomConfig != nil {
		if err := normalizeCustomConfigPayload(payload.CustomConfig); err != nil {
			return err
		}
	}
	for index := range payload.ExchangeRateSnapshots {
		if err := normalizeExchangeRateSnapshotDTO(&payload.ExchangeRateSnapshots[index]); err != nil {
			return fmt.Errorf("exchangeRateSnapshots %d: %w", index+1, err)
		}
	}
	return nil
}

func previewImportPayload(app core.App, user *core.Record, payload importPayload, conflictMode string, skipIndexes []int, forceReplaceIndexes []int) (importPreviewResponse, error) {
	rows, err := listOwnedSubscriptionRecords(app, user.Id)
	if err != nil {
		return importPreviewResponse{}, err
	}
	skippedIndexes, err := importSkippedIndexSet(skipIndexes, len(payload.Subscriptions))
	if err != nil {
		return importPreviewResponse{}, err
	}
	forceReplaceSet, err := importSkippedIndexSet(forceReplaceIndexes, len(payload.Subscriptions))
	if err != nil {
		return importPreviewResponse{}, err
	}
	existingMatches := existingSubscriptionMatches(rows)
	items := make([]importPreviewItem, 0, len(payload.Subscriptions))
	seenPayloadKeys := map[string]bool{}
	for index := range payload.Subscriptions {
		subscription := payload.Subscriptions[index]
		key, keyErr := importKeyFromExtra(subscription.Extra)
		item := importPreviewItem{
			Index:    index,
			Name:     strings.TrimSpace(subscription.Name),
			Warnings: []string{},
			Errors:   []string{},
		}
		if keyErr != nil {
			item.Action = "error"
			item.Errors = append(item.Errors, keyErr.Error())
			items = append(items, item)
			continue
		}
		item.Source = key.Source
		item.SourceID = key.SourceID
		if key.Confidence == "low" {
			item.Warnings = append(item.Warnings, importWarningLowConfidenceKey)
		}
		if skippedIndexes[index] {
			item.Action = "skip"
			items = append(items, item)
			continue
		}
		keyString := importKeyString(key)
		if seenPayloadKeys[keyString] {
			// 单个导入文件里的重复幂等键必须失败；否则 replace 会把两条来源记录写到同一订阅。
			item.Action = "error"
			item.Errors = append(item.Errors, "IMPORT_SOURCE_ID_DUPLICATE")
			items = append(items, item)
			continue
		}
		seenPayloadKeys[keyString] = true
		if err := validateImportSubscription(app, user, subscription); err != nil {
			item.Action = "error"
			item.Errors = append(item.Errors, err.Error())
			items = append(items, item)
			continue
		}
		if existing, fallback := existingMatches.Resolve(key, subscription); existing != nil {
			item.ExistingID = existing.Id
			if fallback {
				// Wallos display:* 只能按名称低置信桥接，给 warning 让用户确认，不把它伪装成精确命中。
				item.Warnings = append(item.Warnings, importWarningLowConfidenceNameMatched)
			}
			if conflictMode == "replace" || forceReplaceSet[index] {
				item.Action = "replace"
			} else {
				item.Action = "skip"
			}
		} else {
			item.Action = "create"
		}
		items = append(items, item)
	}
	return importPreviewResponse{
		Summary:                       summarizeImportItems(items),
		Items:                         items,
		IncludesSettings:              len(strings.TrimSpace(string(payload.Settings))) > 0,
		IncludesCustomConfig:          payload.CustomConfig != nil,
		IncludesExchangeRateSnapshots: len(payload.ExchangeRateSnapshots) > 0,
		ExchangeRateSnapshotsCount:    len(payload.ExchangeRateSnapshots),
		IncludesGroups:                len(payload.Groups) > 0,
		GroupsCount:                   len(payload.Groups),
		IncludesBillingRecords:        len(payload.BillingRecords) > 0,
		BillingRecordsCount:           len(payload.BillingRecords),
	}, nil
}

func applyImportPayload(app core.App, user *core.Record, payload importPayload, conflictMode string, skipIndexes []int, forceReplaceIndexes []int) error {
	// 导入写入包在 PocketBase 事务内完成；任意订阅、settings 或 custom config 失败都不能留下半套迁移数据。
	return app.RunInTransaction(func(txApp core.App) error {
		rows, err := listOwnedSubscriptionRecords(txApp, user.Id)
		if err != nil {
			return err
		}
		collection, err := txApp.FindCollectionByNameOrId("subscriptions")
		if err != nil {
			return err
		}
		skippedIndexes, err := importSkippedIndexSet(skipIndexes, len(payload.Subscriptions))
		if err != nil {
			return err
		}
		forceReplaceSet, err := importSkippedIndexSet(forceReplaceIndexes, len(payload.Subscriptions))
		if err != nil {
			return err
		}
		// 分组必须先于订阅落库：订阅保存时直接写入映射后的目标分组 ID，避免订阅先挂空组再二次回写。
		groupIDMap, err := applyImportedGroups(txApp, user, payload.Groups)
		if err != nil {
			return err
		}
		existingMatches := existingSubscriptionMatches(rows)
		// 记录流水宿主的 源订阅ID → 目标订阅ID 映射：
		// 库内同 ID 订阅（前序分块已恢复，或同实例自恢复）先全部预填，
		// 本次 create/replace 的结果再覆盖写入（跨实例时把源 ID 映射到新记录 ID）。
		// 冲突 skip/用户排除的订阅只要已在库中仍可补齐历史流水；完全无宿主的流水丢弃。
		restoredSubscriptionIDs := map[string]string{}
		for _, row := range rows {
			restoredSubscriptionIDs[row.Id] = row.Id
		}
		for index, subscription := range payload.Subscriptions {
			if skippedIndexes[index] {
				continue
			}
			key, err := importKeyFromExtra(subscription.Extra)
			if err != nil {
				return err
			}
			existing, _ := existingMatches.Resolve(key, subscription)
			if existing != nil && conflictMode == "skip" && !forceReplaceSet[index] {
				continue
			}
			record := existing
			if record == nil {
				record = core.NewRecord(collection)
			}
			setImportSubscriptionRecord(record, user.Id, subscription)
			record.Set("group", mappedImportGroupID(groupIDMap, subscription.GroupID))
			if err := txApp.Save(record); err != nil {
				return err
			}
			restoredSubscriptionIDs[key.SourceID] = record.Id
		}
		scheduleChanged, err := applyImportedSettings(txApp, user, payload.Settings)
		if err != nil {
			return err
		}
		if scheduleChanged {
			// 导入 settings 与订阅事实同处一个事务；重建失败必须回滚整包，不能留下旧时区下的 due-index。
			if _, err := refreshSubscriptionSchedulerState(txApp, user.Id, false); err != nil {
				return err
			}
		}
		if err := applyImportedCustomConfig(txApp, user, payload.CustomConfig); err != nil {
			return err
		}
		if err := applyImportedExchangeRateSnapshots(txApp, user, payload.ExchangeRateSnapshots); err != nil {
			return err
		}
		// 流水是最后一步：订阅/分组全部就绪后，按目标订阅 ID 幂等 upsert。
		if err := applyImportedBillingRecords(txApp, user, payload.BillingRecords, restoredSubscriptionIDs); err != nil {
			return err
		}
		return nil
	})
}

// mappedImportGroupID 把恢复包内的源分组 ID 翻译成目标实例分组 ID；
// 源分组不在包内（被删/未导出）时返回空串，订阅落到“未分组”而不是写入悬挂 relation。
func mappedImportGroupID(groupIDMap map[string]string, sourceGroupID *string) string {
	if sourceGroupID == nil {
		return ""
	}
	return groupIDMap[strings.TrimSpace(*sourceGroupID)]
}

func validateImportSubscription(app core.App, user *core.Record, subscription importSubscription) error {
	collection, err := app.FindCollectionByNameOrId("subscriptions")
	if err != nil {
		return err
	}
	if !isValidBillingCycle(subscription.BillingCycle) {
		return errors.New("BILLING_CYCLE_INVALID")
	}
	if !isValidSubscriptionStatus(subscription.Status) {
		return errors.New("SUBSCRIPTION_STATUS_INVALID")
	}
	record := core.NewRecord(collection)
	setImportSubscriptionRecord(record, user.Id, subscription)
	// 预览只校验不写库；复用 hooks 的核心规范化，保证 Docker 与普通订阅写入边界一致。
	return normalizeSubscriptionRecordWithApp(app, record)
}

func setImportSubscriptionRecord(record *core.Record, userID string, subscription importSubscription) {
	record.Set("user", userID)
	record.Set("name", subscription.Name)
	record.Set("logo", optionalString(subscription.Logo))
	record.Set("price", subscription.Price)
	record.Set("currency", subscription.Currency)
	record.Set("billingCycle", subscription.BillingCycle)
	if subscription.CustomDays != nil {
		record.Set("customDays", *subscription.CustomDays)
	} else {
		record.Set("customDays", 0)
	}
	if subscription.CustomCycleUnit != nil {
		record.Set("customCycleUnit", *subscription.CustomCycleUnit)
	} else {
		record.Set("customCycleUnit", "")
	}
	if subscription.OneTimeTermCount != nil {
		record.Set("oneTimeTermCount", *subscription.OneTimeTermCount)
	} else {
		record.Set("oneTimeTermCount", 0)
	}
	if subscription.OneTimeTermUnit != nil {
		record.Set("oneTimeTermUnit", *subscription.OneTimeTermUnit)
	} else {
		record.Set("oneTimeTermUnit", "")
	}
	if subscription.UsageUnit != nil {
		record.Set("usageUnit", *subscription.UsageUnit)
	} else {
		record.Set("usageUnit", "")
	}
	if subscription.UsageTotal != nil {
		record.Set("usageTotal", *subscription.UsageTotal)
	} else {
		record.Set("usageTotal", 0)
	}
	if subscription.UsageDailyRate != nil {
		record.Set("usageDailyRate", *subscription.UsageDailyRate)
	} else {
		record.Set("usageDailyRate", 0)
	}
	if subscription.UsageExpiresAt != nil {
		record.Set("usageExpiresAt", *subscription.UsageExpiresAt)
	} else {
		record.Set("usageExpiresAt", "")
	}
	record.Set("category", subscription.Category)
	record.Set("status", subscription.Status)
	record.Set("pinned", subscription.Pinned)
	record.Set("publicHidden", subscription.PublicHidden)
	record.Set("paymentMethod", optionalString(subscription.PaymentMethod))
	record.Set("startDate", optionalString(subscription.StartDate))
	record.Set("nextBillingDate", subscription.NextBillingDate)
	record.Set("autoRenew", subscription.BillingCycle != "one-time" && subscription.BillingCycle != "usage-based" && subscription.AutoRenew)
	record.Set("autoCalculateNextBillingDate", subscription.AutoCalculateNextBillingDate)
	record.Set("trialEndDate", optionalString(subscription.TrialEndDate))
	record.Set("website", optionalString(subscription.Website))
	record.Set("notes", optionalString(subscription.Notes))
	record.Set("tags", subscription.Tags)
	record.Set("reminderDays", subscription.ReminderDays)
	record.Set("repeatReminderEnabled", subscription.RepeatReminderEnabled)
	record.Set("repeatReminderInterval", subscription.RepeatReminderInterval)
	record.Set("repeatReminderWindow", subscription.RepeatReminderWindow)
	if subscription.CostSharing != nil {
		record.Set("costSharing", subscription.CostSharing)
	} else {
		record.Set("costSharing", emptyJSONPayload{})
	}
	// extra.import 是导入唯一同源键；只写 allowlist 字段后再整体存入 JSON，避免用户 payload 扩权。
	record.Set("extra", subscription.Extra)
}

func applyImportedSettings(app core.App, user *core.Record, raw json.RawMessage) (bool, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return false, nil
	}
	current := defaultAppSettings()
	record, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": user.Id})
	if err == nil && record != nil {
		current = settingsFromRecord(record)
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	next, err := mergeSettingsForWrite(current, raw)
	if err != nil {
		return false, err
	}
	scheduleChanged := importSettingsAffectSchedule(current, next)
	if record == nil {
		collection, err := app.FindCollectionByNameOrId("settings")
		if err != nil {
			return false, err
		}
		record = core.NewRecord(collection)
		record.Set("user", user.Id)
	}
	record.Set("settings", next)
	if err := app.Save(record); err != nil {
		return false, err
	}
	return scheduleChanged, nil
}

func importSettingsAffectSchedule(before appSettings, after appSettings) bool {
	return before.Timezone != after.Timezone ||
		before.NotificationTimeLocal != after.NotificationTimeLocal ||
		before.NotificationReminderDays != after.NotificationReminderDays
}

func applyImportedCustomConfig(app core.App, user *core.Record, config *customConfigPayload) error {
	if config == nil {
		return nil
	}
	if err := normalizeCustomConfigPayload(config); err != nil {
		return err
	}
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": user.Id})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if record == nil {
		collection, err := app.FindCollectionByNameOrId("custom_configs")
		if err != nil {
			return err
		}
		record = core.NewRecord(collection)
		record.Set("user", user.Id)
	}
	record.Set("config", config)
	return app.Save(record)
}

// applyImportedGroups 在目标用户下按源分组顺序重建分组：同用户同名分组直接复用，
// 保证重复恢复不产生重复组。返回 源分组ID → 目标分组ID 映射供订阅重绑。
// 组 logo 路径已在浏览器侧按新上传资产重写；这里只按字段原样落库。
func applyImportedGroups(app core.App, user *core.Record, groups []importGroup) (map[string]string, error) {
	groupIDMap := map[string]string{}
	if len(groups) == 0 {
		return groupIDMap, nil
	}
	collection, err := app.FindCollectionByNameOrId("subscription_groups")
	if err != nil {
		return nil, err
	}
	for _, group := range groups {
		sourceID := strings.TrimSpace(group.ID)
		name := strings.TrimSpace(group.Name)
		record, err := app.FindFirstRecordByFilter(
			"subscription_groups",
			"user = {:user} && name = {:name}",
			dbx.Params{"user": user.Id, "name": name},
		)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if record == nil {
			record = core.NewRecord(collection)
		}
		record.Set("user", user.Id)
		record.Set("name", name)
		record.Set("logo", optionalString(group.Logo))
		record.Set("description", optionalString(group.Description))
		record.Set("sortOrder", group.SortOrder)
		if err := app.Save(record); err != nil {
			return nil, err
		}
		groupIDMap[sourceID] = record.Id
	}
	return groupIDMap, nil
}

// applyImportedBillingRecords 把恢复包内的流水按目标订阅 ID 幂等 upsert；
// 宿主订阅不在 restoredSubscriptionIDs（被 skip 或本包缺失）时跳过该条，避免悬挂到无关订阅。
func applyImportedBillingRecords(app core.App, user *core.Record, records []billingRecordItem, restoredSubscriptionIDs map[string]string) error {
	for index, record := range records {
		targetSubscriptionID := restoredSubscriptionIDs[strings.TrimSpace(record.SubscriptionID)]
		if targetSubscriptionID == "" {
			continue
		}
		input := billingRecordUpsertFromImport(user.Id, targetSubscriptionID, record)
		if err := upsertBillingRecord(app, input); err != nil {
			return fmt.Errorf("billingRecords %d: %w", index+1, err)
		}
	}
	return nil
}

// billingRecordUpsertFromImport 把恢复包 DTO 转成 upsert 入参；
// 不保留源记录 id（流水按 user+subscription+billingDate+mode 幂等），receiptAssetIds 已是新实例资产 ID。
func billingRecordUpsertFromImport(userID string, targetSubscriptionID string, record billingRecordItem) billingRecordUpsert {
	input := billingRecordUpsert{
		UserID:           userID,
		SubscriptionID:   targetSubscriptionID,
		Name:             strings.TrimSpace(record.Name),
		BillingDate:      record.BillingDate,
		PeriodEndDate:    optionalString(record.PeriodEndDate),
		Amount:           record.Amount,
		Currency:         record.Currency,
		Mode:             record.Mode,
		BillingCycle:     record.BillingCycle,
		CustomDays:       record.CustomDays,
		CustomCycleUnit:  record.CustomCycleUnit,
		OneTimeTermCount: record.OneTimeTermCount,
		OneTimeTermUnit:  record.OneTimeTermUnit,
		UsageUnit:        record.UsageUnit,
		UsageTotal:       record.UsageTotal,
		UsageDailyRate:   record.UsageDailyRate,
		UsageExpiresAt:   optionalString(record.UsageExpiresAt),
		ReceiptAssetIds:  record.ReceiptAssetIds,
	}
	if record.UsageRemainingBefore != nil {
		input.UsageRemainingBefore = *record.UsageRemainingBefore
	}
	return input
}

func existingSubscriptionMatches(rows []*core.Record) importExistingMatches {
	result := importExistingMatches{
		ByKey:                   map[string]*core.Record{},
		LowConfidenceByName:     map[string]*core.Record{},
		LowConfidenceDuplicates: map[string]bool{},
	}
	for _, row := range rows {
		// Renewo 自导出旧记录可能还没有 extra.import；当前用户内用原订阅 id 做二级匹配，保证导出再导入能 replace/skip。
		result.ByKey[importKeyString(importKey{Source: "renewlet", SourceID: row.Id})] = row
		extra := map[string]interface{}{}
		data, err := jsonBytesFromValue(row.Get("extra"))
		if err != nil || len(strings.TrimSpace(string(data))) == 0 {
			continue
		}
		if err := json.Unmarshal(data, &extra); err != nil {
			continue
		}
		key, err := importKeyFromExtra(extra)
		if err != nil {
			continue
		}
		result.ByKey[importKeyString(key)] = row
		if isLowConfidenceWallosKey(key) {
			result.AddLowConfidence(row)
		}
	}
	return result
}

func (matches importExistingMatches) AddLowConfidence(row *core.Record) {
	nameKey := lowConfidenceImportName(row.GetString("name"))
	if nameKey == "" {
		return
	}
	if matches.LowConfidenceDuplicates[nameKey] {
		return
	}
	if matches.LowConfidenceByName[nameKey] != nil {
		// 同名历史订阅一多，名称兜底就失去唯一性；后续必须走用户手动选择。
		delete(matches.LowConfidenceByName, nameKey)
		matches.LowConfidenceDuplicates[nameKey] = true
		return
	}
	matches.LowConfidenceByName[nameKey] = row
}

func (matches importExistingMatches) Resolve(key importKey, subscription importSubscription) (*core.Record, bool) {
	if existing := matches.ByKey[importKeyString(key)]; existing != nil {
		return existing, false
	}
	if !isLowConfidenceWallosKey(key) {
		return nil, false
	}
	nameKey := lowConfidenceImportName(subscription.Name)
	if nameKey == "" || matches.LowConfidenceDuplicates[nameKey] {
		return nil, false
	}
	return matches.LowConfidenceByName[nameKey], matches.LowConfidenceByName[nameKey] != nil
}

func importKeyFromExtra(extra map[string]interface{}) (importKey, error) {
	raw, ok := extra["import"].(map[string]interface{})
	if !ok {
		return importKey{}, errors.New("IMPORT_KEY_REQUIRED")
	}
	source, _ := raw["source"].(string)
	sourceID, _ := raw["sourceId"].(string)
	confidence, _ := raw["confidence"].(string)
	source = strings.TrimSpace(source)
	sourceID = strings.TrimSpace(sourceID)
	if source != "renewlet" && source != "wallos" && source != "ai" {
		return importKey{}, errors.New("IMPORT_SOURCE_INVALID")
	}
	if sourceID == "" || len([]rune(sourceID)) > 256 {
		return importKey{}, errors.New("IMPORT_SOURCE_ID_INVALID")
	}
	if confidence != "" && confidence != "high" && confidence != "low" {
		return importKey{}, errors.New("IMPORT_CONFIDENCE_INVALID")
	}
	return importKey{Source: source, SourceID: sourceID, Confidence: confidence}, nil
}

func importSkippedIndexSet(indexes []int, subscriptionCount int) (map[int]bool, error) {
	result := map[int]bool{}
	for _, index := range indexes {
		if index < 0 || index >= subscriptionCount {
			return nil, errors.New("IMPORT_SKIP_INDEX_INVALID")
		}
		result[index] = true
	}
	return result, nil
}

func isLowConfidenceWallosKey(key importKey) bool {
	return key.Source == "wallos" && (key.Confidence == "low" || strings.HasPrefix(key.SourceID, "display:"))
}

func lowConfidenceImportName(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

func importKeyString(key importKey) string {
	return key.Source + ":" + key.SourceID
}

func summarizeImportItems(items []importPreviewItem) importSummary {
	var summary importSummary
	for _, item := range items {
		summary.Total++
		switch item.Action {
		case "create":
			summary.Creates++
		case "replace":
			summary.Replaces++
		case "skip":
			summary.Skips++
		case "error":
			summary.Errors++
		}
		summary.Warnings += len(item.Warnings)
		if len(item.Errors) > 0 && item.Action != "error" {
			summary.Errors++
		}
	}
	return summary
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func isValidBillingCycle(value string) bool {
	switch value {
	case "weekly", "monthly", "quarterly", "semi-annual", "annual", "custom", "one-time", "usage-based":
		return true
	default:
		return false
	}
}

func isValidSubscriptionStatus(value string) bool {
	switch value {
	case "trial", "active", "expired", "paused", "cancelled":
		return true
	default:
		return false
	}
}
