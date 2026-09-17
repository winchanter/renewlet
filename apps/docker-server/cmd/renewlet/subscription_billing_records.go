package main

// subscription_billing_records.go 承载扣费记录（billing records）的查询、编辑与事务内生成。
//
// 架构位置：
//   - 记录是订阅每期扣费的事实快照：生成时从订阅复制字段，之后独立演化，不与订阅联动回写。
//   - shared packages/shared/src/schemas/billing-records.ts 是 wire shape 事实源；
//     本文件的 DTO、校验与游标语义必须与它逐字段对齐。
//   - 记录生成只发生在订阅写入边界（创建/手动续订/自动续订），并与订阅写入放在同一事务。
import (
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	billingRecordsCollectionName   = "subscription_billing_records"
	billingRecordQueryDefaultLimit = 50
	billingRecordQueryMaxLimit     = 100
	billingRecordCursorMaxChars    = 512
	billingRecordCursorSeparator   = "~"
)

const (
	billingRecordModeInitial        = "initial"
	billingRecordModeAuto           = "auto"
	billingRecordModeManualContinue = "manual_continue"
	billingRecordModeManualRestart  = "manual_restart"
)

// billingRecordItem 是扣费记录的稳定 DTO；周期字段只在对应 billingCycle 下出现（omitempty），
// 与 shared apiBillingRecordSchema 的互斥 refine 保持同形。
type billingRecordItem struct {
	ID               string  `json:"id"`
	SubscriptionID   string  `json:"subscriptionId"`
	Name             string  `json:"name"`
	BillingDate      string  `json:"billingDate"`
	PeriodEndDate    *string `json:"periodEndDate"`
	Amount           string  `json:"amount"`
	Currency         string  `json:"currency"`
	Mode             string  `json:"mode"`
	BillingCycle     string  `json:"billingCycle"`
	CustomDays       int     `json:"customDays,omitempty"`
	CustomCycleUnit  string  `json:"customCycleUnit,omitempty"`
	OneTimeTermCount int     `json:"oneTimeTermCount,omitempty"`
	OneTimeTermUnit  string  `json:"oneTimeTermUnit,omitempty"`
	UsageUnit        string  `json:"usageUnit,omitempty"`
	UsageTotal       float64 `json:"usageTotal,omitempty"`
	UsageDailyRate   float64 `json:"usageDailyRate,omitempty"`
	// usage-based 快照增量：usageTotal 是本次实际购买量，usageRemainingBefore 是结转的旧包余量，
	// 两者之和 = 购买后的订阅持有量；无结转/无失效日时按 optional 语义直接省略。
	UsageRemainingBefore *float64 `json:"usageRemainingBefore,omitempty"`
	UsageExpiresAt       *string  `json:"usageExpiresAt,omitempty"`
	ReceiptAssetIds      []string `json:"receiptAssetIds"`
	CreatedAt            string   `json:"createdAt,omitempty"`
	UpdatedAt            string   `json:"updatedAt,omitempty"`
}

type billingRecordResponse struct {
	Record billingRecordItem `json:"record"`
}

type billingRecordsListResponse struct {
	Records    []billingRecordItem `json:"records"`
	NextCursor *string             `json:"nextCursor"`
	Total      int64               `json:"total"`
}

type billingRecordCursor struct {
	BillingDate string
	ID          string
}

// billingRecordUpsert 是记录写入的单一入参形状；周期字段用零值表达“无”（customDays=0、unit=""）。
type billingRecordUpsert struct {
	UserID           string
	SubscriptionID   string
	Name             string
	BillingDate      string
	PeriodEndDate    string // "" 表示 null：one-time 买断没有周期到期日
	Mode             string
	Amount           string
	Currency         string
	BillingCycle     string
	CustomDays       int
	CustomCycleUnit  string
	OneTimeTermCount int
	OneTimeTermUnit  string
	UsageUnit        string
	UsageTotal       float64
	UsageDailyRate   float64
	// 余量/失效快照用零值表达“无”（remaining=0、expires=""），与 shared nullable+optional 语义对齐。
	UsageRemainingBefore float64
	UsageExpiresAt       string
	ReceiptAssetIds      []string
}

// handleSubscriptionBillingRecordsList 输出某订阅的扣费历史：owner 过滤、billing_date DESC + id DESC keyset 分页。
func handleSubscriptionBillingRecordsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	limit, cursor, err := parseBillingRecordsListQuery(e.Request.URL.Query())
	if err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	filter := "user_id = {:user} && subscription_id = {:sub}"
	params := dbx.Params{"user": e.Auth.Id, "sub": strings.TrimSpace(e.Request.PathValue("id"))}
	if cursor != nil {
		// 游标 keyset 与 shared encodeBillingRecordCursor 对齐：(billing_date, id) 严格小于上一页最后一行。
		filter += " && (billing_date < {:cursor_date} || (billing_date = {:cursor_date} && id < {:cursor_id}))"
		params["cursor_date"] = cursor.BillingDate
		params["cursor_id"] = cursor.ID
	}
	rows, err := app.FindRecordsByFilter(billingRecordsCollectionName, filter, "-billing_date,-id", limit+1, 0, params)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	total, err := app.CountRecords(billingRecordsCollectionName, dbx.HashExp{"user_id": e.Auth.Id, "subscription_id": params["sub"]})
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	records := rows
	nextCursor := (*string)(nil)
	if len(rows) > limit {
		// limit+1 只用来探测“还有下一页”；多出的探测行不能进入响应。
		records = rows[:limit]
		encoded := encodeBillingRecordCursor(records[len(records)-1])
		nextCursor = &encoded
	}
	items := make([]billingRecordItem, 0, len(records))
	for _, row := range records {
		items = append(items, billingRecordItemFromRecord(row))
	}
	return apiSuccessJSON(e, http.StatusOK, billingRecordsListResponse{Records: items, NextCursor: nextCursor, Total: total})
}

// parseBillingRecordsListQuery 与 shared billingRecordsListQuerySchema 对齐：
// 只接受 limit(1..100，默认 50) 与 cursor，未知/重复查询参数一律拒绝，避免两端契约漂移。
func parseBillingRecordsListQuery(values url.Values) (int, *billingRecordCursor, error) {
	for key, entries := range values {
		if (key != "limit" && key != "cursor") || len(entries) != 1 {
			return 0, nil, errors.New("BILLING_RECORDS_QUERY_INVALID")
		}
	}
	limit, err := parsePositiveQueryInt(values.Get("limit"), billingRecordQueryDefaultLimit, 1, billingRecordQueryMaxLimit)
	if err != nil {
		return 0, nil, err
	}
	rawCursor := values.Get("cursor")
	if rawCursor == "" {
		return limit, nil, nil
	}
	if len(rawCursor) > billingRecordCursorMaxChars {
		return 0, nil, errors.New("BILLING_RECORDS_CURSOR_TOO_LONG")
	}
	cursor, ok := decodeBillingRecordCursor(rawCursor)
	if !ok {
		return 0, nil, errors.New("BILLING_RECORDS_CURSOR_INVALID")
	}
	return limit, &cursor, nil
}

// encodeBillingRecordCursor 与 shared 同名函数对齐：date-only 定长且 `~` 不会出现在两者中，可安全拼接。
func encodeBillingRecordCursor(record *core.Record) string {
	return record.GetString("billing_date") + billingRecordCursorSeparator + record.Id
}

func decodeBillingRecordCursor(value string) (billingRecordCursor, bool) {
	index := strings.Index(value, billingRecordCursorSeparator)
	if index <= 0 {
		return billingRecordCursor{}, false
	}
	billingDate := value[:index]
	id := value[index+len(billingRecordCursorSeparator):]
	if !isValidDateOnly(billingDate) || id == "" {
		return billingRecordCursor{}, false
	}
	return billingRecordCursor{BillingDate: billingDate, ID: id}, true
}

// billingRecordItemFromRecord 把持久层行映射成 wire DTO；金额重新走 canonical money，保证跨旧数据仍输出契约形状。
func billingRecordItemFromRecord(record *core.Record) billingRecordItem {
	billingCycle := record.GetString("billing_cycle")
	out := billingRecordItem{
		ID:             record.Id,
		SubscriptionID: record.GetString("subscription_id"),
		Name:           record.GetString("name"),
		BillingDate:    record.GetString("billing_date"),
		PeriodEndDate:  trimmedSubscriptionString(record.GetString("period_end_date")),
		Amount:         moneyForRecord(record.Get("amount")),
		Currency:       record.GetString("currency"),
		Mode:           record.GetString("mode"),
		BillingCycle:   billingCycle,
	}
	if billingCycle == "custom" {
		out.CustomDays = record.GetInt("custom_days")
		out.CustomCycleUnit = strings.TrimSpace(record.GetString("custom_cycle_unit"))
	}
	if billingCycle == "one-time" && record.GetInt("one_time_term_count") > 0 {
		out.OneTimeTermCount = record.GetInt("one_time_term_count")
		out.OneTimeTermUnit = strings.TrimSpace(record.GetString("one_time_term_unit"))
	}
	if billingCycle == "usage-based" {
		out.UsageUnit = strings.TrimSpace(record.GetString("usage_unit"))
		out.UsageTotal = record.GetFloat("usage_total")
		out.UsageDailyRate = record.GetFloat("usage_daily_rate")
		if remaining := record.GetFloat("usage_remaining_before"); remaining > 0 {
			out.UsageRemainingBefore = &remaining
		}
		if expiry := strings.TrimSpace(record.GetString("usage_expires_at")); expiry != "" {
			out.UsageExpiresAt = &expiry
		}
	}
	// receipt_asset_ids 是 JSONField，PocketBase 返回 []any；逐项收敛为 string 切片。
	out.ReceiptAssetIds = readReceiptAssetIds(record.Get("receipt_asset_ids"))
	out.CreatedAt = recordTimeString(record, "created")
	out.UpdatedAt = recordTimeString(record, "updated")
	return out
}

// readReceiptAssetIds 把 PocketBase JSONField 的值收敛为 string 切片；旧记录无此字段时返回空切片。
//
// PocketBase 的 JSONField 经 PrepareValue 返回 types.JSONRaw（底层 []byte 的命名类型），
// Go 的 type switch case []byte 不匹配命名类型，必须显式 case types.JSONRaw 才能命中；
// 否则走 default 返回空，历史记录的凭证缩略图就永远不显示。
func readReceiptAssetIds(raw any) []string {
	if raw == nil {
		return []string{}
	}
	var arr []any
	switch v := raw.(type) {
	case types.JSONRaw:
		if err := json.Unmarshal([]byte(v), &arr); err != nil {
			return []string{}
		}
	case []byte:
		if err := json.Unmarshal(v, &arr); err != nil {
			return []string{}
		}
	case []any:
		arr = v
	default:
		return []string{}
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

// billingRecordPatchRequest 只开放事实修正字段；归属（subscriptionId）与来源（mode/name）字段靠
// DisallowUnknownFields 在解码层直接拒绝，前端无法通过 patch 改写记录来源。
type billingRecordPatchRequest struct {
	Amount               optionalJSONField[string]   `json:"amount"`
	Currency             optionalJSONField[string]   `json:"currency"`
	BillingDate          optionalJSONField[string]   `json:"billingDate"`
	BillingCycle         optionalJSONField[string]   `json:"billingCycle"`
	CustomDays           optionalJSONField[int]      `json:"customDays"`
	CustomCycleUnit      optionalJSONField[string]   `json:"customCycleUnit"`
	OneTimeTermCount     optionalJSONField[int]      `json:"oneTimeTermCount"`
	OneTimeTermUnit      optionalJSONField[string]   `json:"oneTimeTermUnit"`
	UsageUnit            optionalJSONField[string]   `json:"usageUnit"`
	UsageTotal           optionalJSONField[float64]  `json:"usageTotal"`
	UsageDailyRate       optionalJSONField[float64]  `json:"usageDailyRate"`
	UsageRemainingBefore optionalJSONField[float64]  `json:"usageRemainingBefore"`
	UsageExpiresAt       optionalJSONField[string]   `json:"usageExpiresAt"`
	ReceiptAssetIds      optionalJSONField[[]string] `json:"receiptAssetIds"`
}

func (r *billingRecordPatchRequest) HasChanges() bool {
	return r.Amount.Set || r.Currency.Set || r.BillingDate.Set || r.BillingCycle.Set ||
		r.CustomDays.Set || r.CustomCycleUnit.Set || r.OneTimeTermCount.Set || r.OneTimeTermUnit.Set ||
		r.UsageUnit.Set || r.UsageTotal.Set || r.UsageDailyRate.Set ||
		r.UsageRemainingBefore.Set || r.UsageExpiresAt.Set || r.ReceiptAssetIds.Set
}

// touchesPeriod 与 shared billingRecordPatchTouchesPeriod 对齐：这些字段变化时必须重算 periodEndDate。
func (r *billingRecordPatchRequest) touchesPeriod() bool {
	return r.BillingDate.Set || r.BillingCycle.Set || r.CustomDays.Set ||
		r.CustomCycleUnit.Set || r.UsageTotal.Set || r.UsageDailyRate.Set ||
		r.UsageRemainingBefore.Set || r.UsageExpiresAt.Set
}

// Validate 做 patch 白名单字段的逐项校验；金额/币种/日期只接受与订阅写入边界相同的 canonical 形状。
func (r *billingRecordPatchRequest) Validate(locale appLocale) error {
	if !r.HasChanges() {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.Amount.Set && !r.Amount.Null {
		amount, err := canonicalMoneyString(r.Amount.Value)
		if err != nil {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
		r.Amount.Value = amount
	}
	if r.Currency.Set && !r.Currency.Null {
		r.Currency.Value = strings.TrimSpace(r.Currency.Value)
		if !currencyCodeRe.MatchString(r.Currency.Value) {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	}
	if r.BillingDate.Set && !r.BillingDate.Null {
		if err := requireDateOnly(r.BillingDate.Value, "BILLING_DATE"); err != nil {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	}
	if r.BillingCycle.Set && !r.BillingCycle.Null && !isValidBillingCycle(r.BillingCycle.Value) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.CustomDays.Set && !r.CustomDays.Null && r.CustomDays.Value <= 0 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.CustomCycleUnit.Set && !r.CustomCycleUnit.Null && !isValidCustomCycleUnit(r.CustomCycleUnit.Value) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.OneTimeTermCount.Set && !r.OneTimeTermCount.Null &&
		(r.OneTimeTermCount.Value <= 0 || r.OneTimeTermCount.Value > maxReminderDays) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.OneTimeTermUnit.Set && !r.OneTimeTermUnit.Null && !isValidCustomCycleUnit(r.OneTimeTermUnit.Value) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.UsageUnit.Set && !r.UsageUnit.Null {
		r.UsageUnit.Value = strings.TrimSpace(r.UsageUnit.Value)
		if r.UsageUnit.Value == "" || len([]rune(r.UsageUnit.Value)) > 20 {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	}
	if r.UsageTotal.Set && !r.UsageTotal.Null && !isPositiveUsageNumber(r.UsageTotal.Value) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.UsageDailyRate.Set && !r.UsageDailyRate.Null && !isPositiveUsageNumber(r.UsageDailyRate.Value) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.UsageRemainingBefore.Set && !r.UsageRemainingBefore.Null && !isPositiveUsageNumber(r.UsageRemainingBefore.Value) {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	if r.UsageExpiresAt.Set && !r.UsageExpiresAt.Null {
		r.UsageExpiresAt.Value = strings.TrimSpace(r.UsageExpiresAt.Value)
		if err := requireDateOnly(r.UsageExpiresAt.Value, "USAGE_EXPIRES_AT"); err != nil {
			return errors.New(serverText(locale, "common.invalidRequestParameters"))
		}
	}
	if r.ReceiptAssetIds.Set && !r.ReceiptAssetIds.Null && len(r.ReceiptAssetIds.Value) > 6 {
		return errors.New(serverText(locale, "common.invalidRequestParameters"))
	}
	return nil
}

// isPositiveUsageNumber 与 shared usageTotalSchema/usageDailyRateSchema 对齐：正数且不超过订阅金额上限。
func isPositiveUsageNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0 && value <= maxSubscriptionPrice
}

// handleBillingRecordPatch 编辑一条扣费记录：owner 过滤读取、解码合并 patch、重算到期日、事务保存。
// billingCycle 枚举校验复用 import_export.go 的 isValidBillingCycle，避免两处枚举漂移。
// 收窄 receiptAssetIds 时，被移除的凭证资产在同一事务里删除（级联删文件），避免存储留孤儿。
func handleBillingRecordPatch(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[billingRecordPatchRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := app.FindFirstRecordByFilter(
		billingRecordsCollectionName,
		"id = {:id} && user_id = {:user}",
		dbx.Params{"id": strings.TrimSpace(e.Request.PathValue("id")), "user": e.Auth.Id},
	)
	if err != nil || record == nil {
		// 与订阅 renew route 一致：越权和不存在的记录统一 404，避免错误码被拿来枚举他人记录。
		return e.NotFoundError("BILLING_RECORD_NOT_FOUND", err)
	}
	// Original() 是加载时的快照；必须在 applyBillingRecordPatch 改写记录前读取旧凭证列表。
	previousReceiptIds := readReceiptAssetIds(record.Original().Get("receipt_asset_ids"))
	if err := applyBillingRecordPatch(record, body); err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	removedReceiptIds := previousReceiptIds
	if body.ReceiptAssetIds.Set {
		removedReceiptIds = differenceStrings(previousReceiptIds, readReceiptAssetIds(record.Get("receipt_asset_ids")))
	}
	if err := app.RunInTransaction(func(txApp core.App) error {
		if err := txApp.Save(record); err != nil {
			return err
		}
		return deleteOrphanedReceiptAssets(txApp, e.Auth.Id, removedReceiptIds)
	}); err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, billingRecordResponse{Record: billingRecordItemFromRecord(record)})
}

// differenceStrings 返回 in a 中不在 b 里的元素（保持 a 的顺序，不去重；去重由清理侧处理）。
func differenceStrings(a []string, b []string) []string {
	excluded := make(map[string]struct{}, len(b))
	for _, value := range b {
		excluded[value] = struct{}{}
	}
	removed := make([]string, 0, len(a))
	for _, value := range a {
		if _, exists := excluded[value]; !exists {
			removed = append(removed, value)
		}
	}
	return removed
}

// deleteOrphanedReceiptAssets 在记录事务内清理不再被任何记录引用的凭证资产。
//
// 只删当前用户名下的 assets 行（PocketBase 删除记录会级联删除文件字段）；缺失或仍被其他记录引用的 id 跳过，
// 清理失败随事务回滚，避免“记录已改但文件清理被静默丢弃”。
func deleteOrphanedReceiptAssets(app core.App, userID string, assetIDs []string) error {
	seen := make(map[string]struct{}, len(assetIDs))
	for _, assetID := range assetIDs {
		if assetID == "" {
			continue
		}
		if _, exists := seen[assetID]; exists {
			continue
		}
		seen[assetID] = struct{}{}
		count, err := countBillingRecordReceiptReferences(app, userID, assetID)
		if err != nil {
			return err
		}
		if count > 0 {
			continue
		}
		asset, err := app.FindRecordById("assets", assetID)
		if err != nil {
			// 资产行已不存在（此前清理过）视为幂等成功，不阻塞记录编辑。
			continue
		}
		if asset.GetString("user") != userID {
			// 防御：凭证 id 只会来自用户自己的记录，仍不越权删除他人资产。
			continue
		}
		if err := app.Delete(asset); err != nil {
			return err
		}
	}
	return nil
}

// applyBillingRecordPatch 把 patch 合并进记录并执行合并后契约校验：
// 周期字段互斥、金额/币种/日期形状，以及周期影响字段变化时的 periodEndDate 重算。
func applyBillingRecordPatch(record *core.Record, body billingRecordPatchRequest) error {
	if body.Amount.Set {
		if body.Amount.Null {
			return errors.New("AMOUNT_REQUIRED")
		}
		record.Set("amount", body.Amount.Value)
	}
	if body.Currency.Set {
		if body.Currency.Null {
			return errors.New("CURRENCY_REQUIRED")
		}
		record.Set("currency", body.Currency.Value)
	}
	if body.BillingDate.Set {
		if body.BillingDate.Null {
			return errors.New("BILLING_DATE_REQUIRED")
		}
		record.Set("billing_date", body.BillingDate.Value)
	}
	if body.BillingCycle.Set {
		if body.BillingCycle.Null {
			return errors.New("BILLING_CYCLE_REQUIRED")
		}
		record.Set("billing_cycle", body.BillingCycle.Value)
	}
	if body.CustomDays.Set {
		if body.CustomDays.Null {
			record.Set("custom_days", 0)
		} else {
			record.Set("custom_days", body.CustomDays.Value)
		}
	}
	if body.CustomCycleUnit.Set {
		if body.CustomCycleUnit.Null {
			record.Set("custom_cycle_unit", "")
		} else {
			record.Set("custom_cycle_unit", body.CustomCycleUnit.Value)
		}
	}
	if body.OneTimeTermCount.Set {
		if body.OneTimeTermCount.Null {
			record.Set("one_time_term_count", 0)
		} else {
			record.Set("one_time_term_count", body.OneTimeTermCount.Value)
		}
	}
	if body.OneTimeTermUnit.Set {
		if body.OneTimeTermUnit.Null {
			record.Set("one_time_term_unit", "")
		} else {
			record.Set("one_time_term_unit", body.OneTimeTermUnit.Value)
		}
	}
	if body.UsageUnit.Set {
		if body.UsageUnit.Null {
			record.Set("usage_unit", "")
		} else {
			record.Set("usage_unit", body.UsageUnit.Value)
		}
	}
	if body.UsageTotal.Set {
		if body.UsageTotal.Null {
			record.Set("usage_total", 0)
		} else {
			record.Set("usage_total", body.UsageTotal.Value)
		}
	}
	if body.UsageDailyRate.Set {
		if body.UsageDailyRate.Null {
			record.Set("usage_daily_rate", 0)
		} else {
			record.Set("usage_daily_rate", body.UsageDailyRate.Value)
		}
	}
	if body.UsageRemainingBefore.Set {
		if body.UsageRemainingBefore.Null {
			record.Set("usage_remaining_before", 0)
		} else {
			record.Set("usage_remaining_before", body.UsageRemainingBefore.Value)
		}
	}
	if body.UsageExpiresAt.Set {
		if body.UsageExpiresAt.Null {
			record.Set("usage_expires_at", "")
		} else {
			record.Set("usage_expires_at", body.UsageExpiresAt.Value)
		}
	}
	if body.ReceiptAssetIds.Set {
		if body.ReceiptAssetIds.Null {
			record.Set("receipt_asset_ids", []string{})
		} else {
			record.Set("receipt_asset_ids", body.ReceiptAssetIds.Value)
		}
	}
	current := billingRecordUpsertFromRecord(record)
	if !billingRecordCycleIsConsistent(current) {
		return errors.New("BILLING_RECORD_CYCLE_FIELDS_INCONSISTENT")
	}
	if body.touchesPeriod() {
		// 到期日锚点固定为编辑后的扣费日：one-time 置空、usage-based 按预估可用天数、其余按一期推进。
		periodEnd, err := computeBillingRecordPeriodEnd(current)
		if err != nil {
			return err
		}
		record.Set("period_end_date", periodEnd)
	}
	// 合并后的快照必须自洽：periodEndDate 为 null 或 >= billingDate（重算路径天然满足，这里兜底直改日期的旧数据）。
	if periodEnd := record.GetString("period_end_date"); periodEnd != "" && periodEnd < record.GetString("billing_date") {
		return errors.New("BILLING_RECORD_PERIOD_END_BEFORE_BILLING_DATE")
	}
	return nil
}

// billingRecordUpsertFromRecord 把持久层行还原成写入形状，作为 patch 合并与校验的基准。
func billingRecordUpsertFromRecord(record *core.Record) billingRecordUpsert {
	return billingRecordUpsert{
		UserID:               record.GetString("user_id"),
		SubscriptionID:       record.GetString("subscription_id"),
		Name:                 record.GetString("name"),
		BillingDate:          record.GetString("billing_date"),
		PeriodEndDate:        record.GetString("period_end_date"),
		Mode:                 record.GetString("mode"),
		Amount:               record.GetString("amount"),
		Currency:             record.GetString("currency"),
		BillingCycle:         record.GetString("billing_cycle"),
		CustomDays:           record.GetInt("custom_days"),
		CustomCycleUnit:      record.GetString("custom_cycle_unit"),
		OneTimeTermCount:     record.GetInt("one_time_term_count"),
		OneTimeTermUnit:      record.GetString("one_time_term_unit"),
		UsageUnit:            record.GetString("usage_unit"),
		UsageTotal:           record.GetFloat("usage_total"),
		UsageDailyRate:       record.GetFloat("usage_daily_rate"),
		UsageRemainingBefore: record.GetFloat("usage_remaining_before"),
		UsageExpiresAt:       strings.TrimSpace(record.GetString("usage_expires_at")),
		ReceiptAssetIds:      readReceiptAssetIds(record.Get("receipt_asset_ids")),
	}
}

// billingRecordCycleIsConsistent 与 shared billingRecordCycleIsConsistent 对齐：
// custom→customDays+customCycleUnit 成对且其余周期字段为空；one-time→termCount/termUnit 成对；
// usage-based→usageUnit+usageTotal+usageDailyRate 齐全；其余周期→全部为空。
func billingRecordCycleIsConsistent(value billingRecordUpsert) bool {
	// 余量/失效快照是 usage-based 专用；其余周期必须为空，避免切周期后残留值扭曲重算。
	withoutUsageSnapshot := value.UsageRemainingBefore == 0 && value.UsageExpiresAt == ""
	switch value.BillingCycle {
	case "custom":
		return value.CustomDays > 0 && isValidCustomCycleUnit(value.CustomCycleUnit) &&
			value.OneTimeTermCount == 0 && value.OneTimeTermUnit == "" &&
			value.UsageUnit == "" && value.UsageTotal == 0 && value.UsageDailyRate == 0 &&
			withoutUsageSnapshot
	case "one-time":
		return (value.OneTimeTermCount > 0) == isValidCustomCycleUnit(value.OneTimeTermUnit) &&
			value.CustomDays == 0 && value.CustomCycleUnit == "" &&
			value.UsageUnit == "" && value.UsageTotal == 0 && value.UsageDailyRate == 0 &&
			withoutUsageSnapshot
	case "usage-based":
		return value.UsageUnit != "" && value.UsageTotal > 0 && value.UsageDailyRate > 0 &&
			value.CustomDays == 0 && value.CustomCycleUnit == "" &&
			value.OneTimeTermCount == 0 && value.OneTimeTermUnit == ""
	default:
		return value.CustomDays == 0 && value.CustomCycleUnit == "" &&
			value.OneTimeTermCount == 0 && value.OneTimeTermUnit == "" &&
			value.UsageUnit == "" && value.UsageTotal == 0 && value.UsageDailyRate == 0 &&
			withoutUsageSnapshot
	}
}

// computeBillingRecordPeriodEnd 与 shared computeBillingRecordPeriodEnd 对齐；
// 输入是已合并的记录形状，输出 date-only 字符串（"" 表示 null）。USAGE_* 错误由调用方映射为 400。
func computeBillingRecordPeriodEnd(value billingRecordUpsert) (string, error) {
	if value.BillingCycle == "one-time" {
		return "", nil
	}
	if value.BillingCycle == "usage-based" {
		// 持有量 = 本次购买量 + 结转余量；到期边界取 min(推算耗尽日, 失效日)，与订阅行口径一致。
		holding := value.UsageTotal + value.UsageRemainingBefore
		days, err := usageEstimatedDays(holding, value.UsageDailyRate)
		if err != nil {
			return "", err
		}
		anchor, err := parseDateOnly(value.BillingDate)
		if err != nil {
			return "", err
		}
		exhaustion := formatDateOnly(anchor.AddDate(0, 0, days))
		if value.UsageExpiresAt != "" && isValidDateOnly(value.UsageExpiresAt) && value.UsageExpiresAt < exhaustion {
			return value.UsageExpiresAt, nil
		}
		return exhaustion, nil
	}
	anchor, err := parseDateOnly(value.BillingDate)
	if err != nil {
		return "", err
	}
	end, err := addBillingCyclesDate(anchor, value.BillingCycle, 1, value.CustomDays, value.CustomCycleUnit)
	if err != nil {
		return "", err
	}
	return formatDateOnly(end), nil
}

// billingRecordUpsertSnapshot 从订阅 record 复制快照字段（名称、金额、币种、周期字段）。
// 金额统一走 canonical money，让记录与订阅在旧 number 数据上也输出同一 wire shape。
func billingRecordUpsertSnapshot(subscription *core.Record) billingRecordUpsert {
	return billingRecordUpsert{
		UserID:           subscription.GetString("user"),
		SubscriptionID:   subscription.Id,
		Name:             subscription.GetString("name"),
		Amount:           moneyForRecord(subscription.Get("price")),
		Currency:         subscription.GetString("currency"),
		BillingCycle:     subscription.GetString("billingCycle"),
		CustomDays:       subscription.GetInt("customDays"),
		CustomCycleUnit:  subscription.GetString("customCycleUnit"),
		OneTimeTermCount: subscription.GetInt("oneTimeTermCount"),
		OneTimeTermUnit:  subscription.GetString("oneTimeTermUnit"),
		UsageUnit:        subscription.GetString("usageUnit"),
		UsageTotal:       subscription.GetFloat("usageTotal"),
		UsageDailyRate:   subscription.GetFloat("usageDailyRate"),
		// 订阅行不保存结转余量（余量只在续订瞬间吸收进总量并快照进记录）；失效日随订阅快照。
		UsageExpiresAt: subscription.GetString("usageExpiresAt"),
	}
}

// billingRecordUsageOverride 是手动续订生成扣费记录时的 usage 快照覆盖：
// restart 购买新量包时记录里存“本次实际购买量 + 结转余量”，而不是订阅行吸收后的持有总量。
type billingRecordUsageOverride struct {
	UsageTotal           float64
	UsageRemainingBefore float64
	UsageExpiresAt       string
}

// upsertInitialBillingRecord 在创建订阅的同一事务内生成 mode=initial 首期记录：
// billing_date = startDate ?? nextBillingDate，period_end_date = nextBillingDate。
func upsertInitialBillingRecord(app core.App, subscription *core.Record) error {
	input := billingRecordUpsertSnapshot(subscription)
	input.BillingDate = subscription.GetString("startDate")
	if !isValidDateOnly(input.BillingDate) {
		input.BillingDate = subscription.GetString("nextBillingDate")
	}
	input.PeriodEndDate = subscription.GetString("nextBillingDate")
	input.Mode = billingRecordModeInitial
	return upsertBillingRecord(app, input)
}

// upsertManualRenewalBillingRecord 在手动续订的同一事务内生成 manual_continue/manual_restart 记录；
// billingDate 由调用方按 continue=旧 nextBillingDate / restart=请求 startDate 提供，区间终点是续订后的新到期日。
// usageOverride 仅在 usage-based restart 购买新量包时提供：把“购买量+结转余量”快照进记录。
func upsertManualRenewalBillingRecord(app core.App, subscription *core.Record, mode string, billingDate string, receiptAssetIds []string, usageOverride *billingRecordUsageOverride) error {
	input := billingRecordUpsertSnapshot(subscription)
	input.BillingDate = billingDate
	input.PeriodEndDate = subscription.GetString("nextBillingDate")
	input.Mode = mode
	input.ReceiptAssetIds = receiptAssetIds
	if usageOverride != nil {
		input.UsageTotal = usageOverride.UsageTotal
		input.UsageRemainingBefore = usageOverride.UsageRemainingBefore
		input.UsageExpiresAt = usageOverride.UsageExpiresAt
	}
	return upsertBillingRecord(app, input)
}

// generateAutoRenewalBillingRecords 为一次自动续订覆盖的每一期逐条生成 mode=auto 记录：
// cur 从旧 nextBillingDate 起、以“当期+1 周期”为区间终点推进，直到新 nextBillingDate。
// usage-based/one-time 没有可推进周期（usage-based 也不应进入自动续订），遇到即跳过生成。
func generateAutoRenewalBillingRecords(app core.App, snapshot billingRecordUpsert, previousNextBillingDate string, newNextBillingDate string) error {
	if snapshot.BillingCycle == "usage-based" || snapshot.BillingCycle == "one-time" {
		return nil
	}
	if !isValidDateOnly(previousNextBillingDate) || !isValidDateOnly(newNextBillingDate) {
		return nil
	}
	cur := previousNextBillingDate
	for attempts := 0; cur < newNextBillingDate; attempts++ {
		if attempts >= maxAdvanceCycles {
			// 与 shared MAX_ADVANCE_CYCLES 对齐：脏数据不能让维护任务在单条订阅上无限写记录。
			return errors.New("SUBSCRIPTION_RENEWAL_ADVANCE_LIMIT_EXCEEDED")
		}
		anchor, err := parseDateOnly(cur)
		if err != nil {
			return err
		}
		end, err := addBillingCyclesDate(anchor, snapshot.BillingCycle, 1, snapshot.CustomDays, snapshot.CustomCycleUnit)
		if err != nil {
			return err
		}
		endDate := formatDateOnly(end)
		period := snapshot
		period.BillingDate = cur
		period.PeriodEndDate = endDate
		period.Mode = billingRecordModeAuto
		if err := upsertBillingRecord(app, period); err != nil {
			return err
		}
		if endDate <= cur {
			return errors.New("SUBSCRIPTION_RENEWAL_ADVANCE_LIMIT_EXCEEDED")
		}
		cur = endDate
	}
	return nil
}

// validateBillingRecordUpsert 是扣费记录的纯事实校验（不触碰数据库），
// 同时服务续订写路径与备份恢复预览，保证两条入口的拒绝口径一致。
func validateBillingRecordUpsert(input billingRecordUpsert) error {
	if input.UserID == "" || input.SubscriptionID == "" || strings.TrimSpace(input.Name) == "" {
		return errors.New("BILLING_RECORD_IDENTITY_REQUIRED")
	}
	switch input.Mode {
	case billingRecordModeInitial, billingRecordModeAuto, billingRecordModeManualContinue, billingRecordModeManualRestart:
	default:
		return errors.New("BILLING_RECORD_MODE_INVALID")
	}
	if err := requireDateOnly(input.BillingDate, "BILLING_DATE"); err != nil {
		return err
	}
	if input.PeriodEndDate != "" {
		if err := requireDateOnly(input.PeriodEndDate, "PERIOD_END_DATE"); err != nil {
			return err
		}
		if input.PeriodEndDate < input.BillingDate {
			return errors.New("BILLING_RECORD_PERIOD_END_BEFORE_BILLING_DATE")
		}
	}
	if input.UsageExpiresAt != "" {
		if err := requireDateOnly(input.UsageExpiresAt, "USAGE_EXPIRES_AT"); err != nil {
			return err
		}
		if input.UsageExpiresAt < input.BillingDate {
			return errors.New("BILLING_RECORD_USAGE_EXPIRES_BEFORE_BILLING_DATE")
		}
	}
	if _, err := canonicalMoneyString(input.Amount); err != nil {
		return errors.New("BILLING_RECORD_AMOUNT_INVALID")
	}
	if !currencyCodeRe.MatchString(input.Currency) {
		return errors.New("BILLING_RECORD_CURRENCY_INVALID")
	}
	if !billingRecordCycleIsConsistent(input) {
		return errors.New("BILLING_RECORD_CYCLE_FIELDS_INCONSISTENT")
	}
	return nil
}

// upsertBillingRecord 按 (user_id, subscription_id, billing_date, mode) 幂等写入扣费记录：
// 已有行只更新快照字段（不改 id/created_at），否则创建。必须在订阅写入的同一事务内调用，
// 让“订阅状态变化”与“历史记录快照”原子落库。
func upsertBillingRecord(app core.App, input billingRecordUpsert) error {
	if err := validateBillingRecordUpsert(input); err != nil {
		return err
	}
	// 校验已保证金额合法；落库前再走一次 canonical，保证旧脏输入也按规范金额存储。
	amount, err := canonicalMoneyString(input.Amount)
	if err != nil {
		return errors.New("BILLING_RECORD_AMOUNT_INVALID")
	}
	record, err := app.FindFirstRecordByFilter(
		billingRecordsCollectionName,
		"user_id = {:user} && subscription_id = {:sub} && billing_date = {:date} && mode = {:mode}",
		dbx.Params{"user": input.UserID, "sub": input.SubscriptionID, "date": input.BillingDate, "mode": input.Mode},
	)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection, err := app.FindCollectionByNameOrId(billingRecordsCollectionName)
		if err != nil {
			return err
		}
		record = core.NewRecord(collection)
	}
	record.Set("user_id", input.UserID)
	record.Set("subscription_id", input.SubscriptionID)
	record.Set("name", input.Name)
	record.Set("billing_date", input.BillingDate)
	record.Set("period_end_date", input.PeriodEndDate)
	record.Set("amount", amount)
	record.Set("currency", input.Currency)
	record.Set("billing_cycle", input.BillingCycle)
	record.Set("custom_days", input.CustomDays)
	record.Set("custom_cycle_unit", input.CustomCycleUnit)
	record.Set("one_time_term_count", input.OneTimeTermCount)
	record.Set("one_time_term_unit", input.OneTimeTermUnit)
	record.Set("usage_unit", input.UsageUnit)
	record.Set("usage_total", input.UsageTotal)
	record.Set("usage_daily_rate", input.UsageDailyRate)
	record.Set("usage_remaining_before", input.UsageRemainingBefore)
	record.Set("usage_expires_at", input.UsageExpiresAt)
	record.Set("mode", input.Mode)
	if input.ReceiptAssetIds == nil {
		input.ReceiptAssetIds = []string{}
	}
	record.Set("receipt_asset_ids", input.ReceiptAssetIds)
	return app.Save(record)
}
