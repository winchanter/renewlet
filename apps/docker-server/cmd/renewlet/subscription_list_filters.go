package main

// subscription_list_filters.go 只在 owner-scoped 派生投影上筛选和分页，再一次性回表读取完整事实记录。
// cursor 只裁当前页，total 始终来自同一完整过滤集，避免滚动后总数递减或筛选口径漂移。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	subscriptionListDefaultLimit       = 50
	subscriptionListMaxLimit           = 100
	subscriptionListScanPageSize       = 500
	subscriptionListSearchMaxLength    = 200
	subscriptionPaymentMethodNoneValue = "__none"
)

type subscriptionListQuery struct {
	Limit           int
	Cursor          *subscriptionCursorPayload
	Search          string
	Categories      []string
	Tags            []string
	BillingCycles   []string
	PaymentMethods  []string
	Currencies      []string
	Status          string
	Renewal         string
	NextBillingFrom string
	NextBillingTo   string
	Pinned          *bool
	PublicHidden    *bool
	ReminderMode    string
	RepeatReminder  *bool
}

type subscriptionListPage struct {
	Rows       []*core.Record
	NextCursor *string
	Total      int64
}

func parseSubscriptionListQuery(values url.Values) (subscriptionListQuery, error) {
	return parseSubscriptionCollectionQuery(values, true)
}

func parseSubscriptionIndexQuery(values url.Values) (subscriptionListQuery, error) {
	return parseSubscriptionCollectionQuery(values, false)
}

func parseSubscriptionCollectionQuery(values url.Values, paginated bool) (subscriptionListQuery, error) {
	for key := range values {
		if isSubscriptionCollectionFilterKey(key) || paginated && (key == "limit" || key == "cursor") {
			continue
		}
		return subscriptionListQuery{}, fmt.Errorf("unsupported subscription query parameter %q", key)
	}
	limit := subscriptionListDefaultLimit
	var err error
	if paginated {
		if rawLimits, ok := values["limit"]; ok && (len(rawLimits) != 1 || strings.TrimSpace(rawLimits[0]) == "") {
			return subscriptionListQuery{}, errors.New("invalid limit query value")
		}
		limit, err = parsePositiveQueryInt(values.Get("limit"), subscriptionListDefaultLimit, 1, subscriptionListMaxLimit)
	}
	if err != nil {
		return subscriptionListQuery{}, err
	}
	query := subscriptionListQuery{Limit: limit}
	if paginated {
		rawCursors, hasCursor := values["cursor"]
		if !hasCursor {
			return parseSubscriptionCollectionFilters(values, query)
		}
		if len(rawCursors) != 1 || strings.TrimSpace(rawCursors[0]) == "" {
			return subscriptionListQuery{}, errors.New("invalid cursor query value")
		}
		rawCursor := strings.TrimSpace(rawCursors[0])
		cursor, err := parseSubscriptionCursorPayload(rawCursor)
		if err != nil {
			return subscriptionListQuery{}, err
		}
		query.Cursor = &cursor
	}
	return parseSubscriptionCollectionFilters(values, query)
}

func parseSubscriptionCollectionFilters(values url.Values, query subscriptionListQuery) (subscriptionListQuery, error) {
	var err error
	if query.Search, err = parseSubscriptionListSingle(values, "q", subscriptionListSearchMaxLength, nil); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Categories, err = parseSubscriptionListStrings(values["category"], 50, 80, nil); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Tags, err = parseSubscriptionListStrings(values["tag"], 100, 40, nil); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.BillingCycles, err = parseSubscriptionListStrings(values["billingCycle"], 7, 40, isValidBillingCycle); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.PaymentMethods, err = parseSubscriptionListStrings(values["paymentMethod"], 200, 80, isValidSubscriptionListPaymentMethod); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Currencies, err = parseSubscriptionListStrings(values["currency"], 50, 3, isSubscriptionListCurrency); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Status, err = parseSubscriptionListSingle(values, "status", 40, isValidSubscriptionStatus); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.Renewal, err = parseSubscriptionListSingle(values, "renewal", 20, isSubscriptionListRenewal); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingFrom, err = parseSubscriptionListSingle(values, "nextBillingFrom", 10, isValidDateOnly); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingTo, err = parseSubscriptionListSingle(values, "nextBillingTo", 10, isValidDateOnly); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.NextBillingFrom != "" && query.NextBillingTo != "" && query.NextBillingFrom > query.NextBillingTo {
		return subscriptionListQuery{}, errors.New("invalid next billing range")
	}
	if query.Pinned, err = parseSubscriptionListBool(values, "pinned"); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.PublicHidden, err = parseSubscriptionListBool(values, "publicHidden"); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.ReminderMode, err = parseSubscriptionListSingle(values, "reminderMode", 20, isSubscriptionListReminderMode); err != nil {
		return subscriptionListQuery{}, err
	}
	if query.RepeatReminder, err = parseSubscriptionListBool(values, "repeatReminder"); err != nil {
		return subscriptionListQuery{}, err
	}
	return query, nil
}

func isSubscriptionCollectionFilterKey(key string) bool {
	switch key {
	case "q", "category", "tag", "billingCycle", "paymentMethod", "currency", "status", "renewal",
		"nextBillingFrom", "nextBillingTo", "pinned", "publicHidden", "reminderMode", "repeatReminder":
		return true
	default:
		return false
	}
}

func listSubscriptionRecordsForQuery(app core.App, userID string, query subscriptionListQuery, today string) (subscriptionListPage, error) {
	// 该入口的查询预算固定为一次投影页查询和一次批量事实回表；禁止恢复逐 ID PocketBase 查询。
	pageIDs, total, err := projectedSubscriptionPageIDs(app, userID, query, today)
	if err != nil {
		return subscriptionListPage{}, err
	}
	rows, err := getSubscriptionRecordsByIDs(app, userID, pageIDs)
	if err != nil {
		return subscriptionListPage{}, err
	}
	var nextCursor *string
	if len(rows) > query.Limit {
		rows = rows[:query.Limit]
		cursor := encodeSubscriptionCursor(rows[len(rows)-1])
		nextCursor = &cursor
	}
	return subscriptionListPage{Rows: rows, NextCursor: nextCursor, Total: total}, nil
}

func boundedSubscriptionRecordsForQuery(
	app core.App,
	userID string,
	query subscriptionListQuery,
	today string,
	limit int,
) (subscriptionListPage, bool, error) {
	query.Cursor = nil
	query.Limit = limit
	pageIDs, total, err := projectedSubscriptionPageIDs(app, userID, query, today)
	if err != nil {
		return subscriptionListPage{}, false, err
	}
	// 超限只需要投影总数即可判定，不能先把 5001 条完整 PocketBase 记录搬进内存再丢弃。
	if total > int64(limit) {
		return subscriptionListPage{Total: total}, true, nil
	}
	rows, err := getSubscriptionRecordsByIDs(app, userID, pageIDs)
	if err != nil {
		return subscriptionListPage{}, false, err
	}
	return subscriptionListPage{Rows: rows, Total: total}, false, nil
}

func projectedSubscriptionPageIDs(app core.App, userID string, query subscriptionListQuery, today string) ([]string, int64, error) {
	base := subscriptionProjectionBaseQuery(userID, query)
	if query.Search != "" {
		base.conditions = append(base.conditions, "instr(idx.search_text_lower, {:search}) > 0")
		base.params["search"] = strings.ToLower(strings.TrimSpace(query.Search))
	}
	if query.Status != "" {
		base.conditions = append(base.conditions, `(CASE
			WHEN idx.status = 'expired' THEN 'expired'
			WHEN idx.billing_cycle = 'one-time' AND idx.one_time_term_count <= 0 THEN idx.status
			WHEN idx.status IN ('active', 'trial') AND idx.next_billing_date < {:today} THEN 'expired'
			ELSE idx.status
		END) = {:status}`)
		base.params["today"] = today
		base.params["status"] = query.Status
	}
	rows, err := runSubscriptionProjectionPage(app, base, query.Limit+1, query.Cursor)
	if err != nil {
		return nil, 0, err
	}
	if len(rows) == 0 {
		return []string{}, 0, nil
	}
	return subscriptionProjectionIDs(rows), int64(rows[0].TotalCount), nil
}

type subscriptionProjectionBase struct {
	conditions []string
	params     dbx.Params
}

func subscriptionProjectionBaseQuery(userID string, query subscriptionListQuery) subscriptionProjectionBase {
	base := subscriptionProjectionBase{
		conditions: []string{"idx.user_id = {:user}"},
		params:     dbx.Params{"user": userID},
	}
	appendSQLInCondition(&base, "idx.category", "category", query.Categories)
	appendSQLInCondition(&base, "idx.billing_cycle", "billingCycle", query.BillingCycles)
	appendSQLInCondition(&base, "idx.currency", "currency", query.Currencies)
	appendSQLPaymentMethodCondition(&base, query.PaymentMethods)
	appendSQLRenewalCondition(&base, query.Renewal)
	appendSQLTagCondition(&base, query.Tags)
	if query.NextBillingFrom != "" {
		base.conditions = append(base.conditions, "idx.next_billing_date >= {:nextBillingFrom}")
		base.params["nextBillingFrom"] = query.NextBillingFrom
	}
	if query.NextBillingTo != "" {
		base.conditions = append(base.conditions, "idx.next_billing_date <= {:nextBillingTo}")
		base.params["nextBillingTo"] = query.NextBillingTo
	}
	if query.Pinned != nil {
		base.conditions = append(base.conditions, "idx.pinned = {:pinned}")
		base.params["pinned"] = boolToSQLiteInt(*query.Pinned)
	}
	if query.PublicHidden != nil {
		base.conditions = append(base.conditions, "idx.public_hidden = {:publicHidden}")
		base.params["publicHidden"] = boolToSQLiteInt(*query.PublicHidden)
	}
	appendSQLReminderModeCondition(&base, query.ReminderMode)
	if query.RepeatReminder != nil {
		base.conditions = append(base.conditions, "idx.repeat_reminder_enabled = {:repeatReminder}")
		base.params["repeatReminder"] = boolToSQLiteInt(*query.RepeatReminder)
	}
	return base
}

func runSubscriptionProjectionPage(app core.App, base subscriptionProjectionBase, limit int, cursor *subscriptionCursorPayload) ([]subscriptionListIndexRow, error) {
	pageConditions := []string{"1 = 1"}
	params := dbx.Params{}
	for key, value := range base.params {
		params[key] = value
	}
	if cursor != nil {
		pageConditions = append(pageConditions, "(idx.created_at < {:cursorCreatedAt} OR (idx.created_at = {:cursorCreatedAt} AND idx.subscription_id < {:cursorID}))")
		params["cursorCreatedAt"] = cursor.CreatedAt
		params["cursorID"] = cursor.ID
	}
	params["limit"] = limit
	var rows []subscriptionListIndexRow
	// filtered CTE 先锁定 owner 并计算完整过滤集；外层 cursor 只裁当前页，不改变 total。
	err := app.DB().NewQuery(fmt.Sprintf(`WITH filtered AS (
			SELECT subscription_id, user_id, name, website, notes, search_text_lower, category, billing_cycle, currency,
				payment_method, status, pinned, public_hidden, next_billing_date, trial_end_date, one_time_term_count,
				auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
			FROM subscription_list_index AS idx
			WHERE %s
		), page AS (
			SELECT * FROM filtered AS idx
			WHERE %s
			ORDER BY idx.created_at DESC, idx.subscription_id DESC
			LIMIT {:limit}
		), totals AS (
			SELECT COUNT(*) AS total_count FROM filtered
		)
			SELECT COALESCE(page.subscription_id, '') AS subscription_id, COALESCE(page.user_id, '') AS user_id,
			COALESCE(page.name, '') AS name, COALESCE(page.website, '') AS website, COALESCE(page.notes, '') AS notes,
			COALESCE(page.search_text_lower, '') AS search_text_lower, COALESCE(page.category, '') AS category,
			COALESCE(page.billing_cycle, '') AS billing_cycle, COALESCE(page.currency, '') AS currency,
			COALESCE(page.payment_method, '') AS payment_method, COALESCE(page.status, '') AS status,
			COALESCE(page.pinned, 0) AS pinned, COALESCE(page.public_hidden, 0) AS public_hidden,
			COALESCE(page.next_billing_date, '') AS next_billing_date, COALESCE(page.trial_end_date, '') AS trial_end_date,
			COALESCE(page.one_time_term_count, 0) AS one_time_term_count, COALESCE(page.auto_renew, 0) AS auto_renew,
			COALESCE(page.reminder_days, 0) AS reminder_days,
			COALESCE(page.repeat_reminder_enabled, 0) AS repeat_reminder_enabled,
			COALESCE(page.created_at, '') AS created_at, COALESCE(page.updated_at, '') AS updated_at,
			totals.total_count
			FROM totals LEFT JOIN page ON 1 = 1
			ORDER BY page.created_at DESC, page.subscription_id DESC`, strings.Join(base.conditions, " AND "), strings.Join(pageConditions, " AND "))).
		Bind(params).
		All(&rows)
	return rows, err
}

func appendSQLInCondition(base *subscriptionProjectionBase, column string, prefix string, values []string) {
	if len(values) == 0 {
		return
	}
	placeholders := make([]string, 0, len(values))
	for index, value := range values {
		key := prefix + strconv.Itoa(index)
		placeholders = append(placeholders, "{:"+key+"}")
		base.params[key] = value
	}
	base.conditions = append(base.conditions, column+" IN ("+strings.Join(placeholders, ", ")+")")
}

func appendSQLPaymentMethodCondition(base *subscriptionProjectionBase, values []string) {
	if len(values) == 0 {
		return
	}
	parts := []string{}
	concrete := []string{}
	for _, value := range values {
		if value == subscriptionPaymentMethodNoneValue {
			parts = append(parts, "idx.payment_method = ''")
		} else {
			concrete = append(concrete, value)
		}
	}
	if len(concrete) > 0 {
		placeholders := make([]string, 0, len(concrete))
		for index, value := range concrete {
			key := "paymentMethod" + strconv.Itoa(index)
			placeholders = append(placeholders, "{:"+key+"}")
			base.params[key] = value
		}
		parts = append(parts, "idx.payment_method IN ("+strings.Join(placeholders, ", ")+")")
	}
	base.conditions = append(base.conditions, "("+strings.Join(parts, " OR ")+")")
}

func appendSQLRenewalCondition(base *subscriptionProjectionBase, renewal string) {
	switch renewal {
	case "auto":
		base.conditions = append(base.conditions, "idx.billing_cycle NOT IN ('one-time', 'usage-based') AND idx.auto_renew = 1")
	case "manual":
		base.conditions = append(base.conditions, "idx.billing_cycle NOT IN ('one-time', 'usage-based') AND idx.auto_renew = 0")
	case "one-time":
		// 一次性购买包含买断与预付量包；两者都没有自动推进的扣费周期。
		base.conditions = append(base.conditions, "idx.billing_cycle IN ('one-time', 'usage-based')")
	}
}

func appendSQLTagCondition(base *subscriptionProjectionBase, values []string) {
	if len(values) == 0 {
		return
	}
	parts := make([]string, 0, len(values))
	for index, tag := range values {
		keyNorm := "tagNorm" + strconv.Itoa(index)
		keyValue := "tag" + strconv.Itoa(index)
		parts = append(parts, "(tag.tag_norm = {:"+keyNorm+"} AND tag.tag = {:"+keyValue+"})")
		base.params[keyNorm] = strings.ToLower(tag)
		base.params[keyValue] = tag
	}
	base.conditions = append(base.conditions, `EXISTS (
		SELECT 1 FROM subscription_tags AS tag
		WHERE tag.user_id = idx.user_id
			AND tag.subscription_id = idx.subscription_id
			AND (`+strings.Join(parts, " OR ")+`)
	)`)
}

func appendSQLReminderModeCondition(base *subscriptionProjectionBase, mode string) {
	switch mode {
	case "disabled":
		base.conditions = append(base.conditions, "idx.reminder_days = -2")
	case "inherit":
		base.conditions = append(base.conditions, "idx.reminder_days = -1")
	case "custom":
		base.conditions = append(base.conditions, "idx.reminder_days >= 0")
	}
}

func subscriptionProjectionIDs(rows []subscriptionListIndexRow) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.SubscriptionID != "" {
			ids = append(ids, row.SubscriptionID)
		}
	}
	return ids
}

func subscriptionRecordStringSlice(record *core.Record, name string) []string {
	data, err := jsonBytesFromValue(record.Get(name))
	if err != nil || len(data) == 0 {
		return []string{}
	}
	var values []string
	if err := json.Unmarshal(data, &values); err != nil || values == nil {
		return []string{}
	}
	return values
}

func parseSubscriptionListStrings(values []string, maxItems int, maxLength int, validate func(string) bool) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > maxItems {
		return nil, errors.New("too many query values")
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || len(value) > maxLength {
			return nil, errors.New("invalid query value")
		}
		if validate != nil && !validate(value) {
			return nil, errors.New("invalid query value")
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out, nil
}

func parseSubscriptionListSingle(values url.Values, name string, maxLength int, validate func(string) bool) (string, error) {
	rawValues := values[name]
	if len(rawValues) == 0 {
		return "", nil
	}
	if len(rawValues) > 1 {
		return "", errors.New("duplicate query value")
	}
	value := strings.TrimSpace(rawValues[0])
	if value == "" || len(value) > maxLength {
		return "", errors.New("invalid query value")
	}
	if validate != nil && !validate(value) {
		return "", errors.New("invalid query value")
	}
	return value, nil
}

func parseSubscriptionListBool(values url.Values, name string) (*bool, error) {
	rawValues := values[name]
	if len(rawValues) == 0 {
		return nil, nil
	}
	if len(rawValues) > 1 {
		return nil, errors.New("duplicate boolean query value")
	}
	var parsed bool
	switch strings.TrimSpace(rawValues[0]) {
	case "true", "1":
		parsed = true
	case "false", "0":
		parsed = false
	default:
		return nil, errors.New("invalid boolean query value")
	}
	return &parsed, nil
}

func isValidSubscriptionListPaymentMethod(value string) bool {
	return value == subscriptionPaymentMethodNoneValue || (strings.TrimSpace(value) == value && value != "")
}

func isSubscriptionListCurrency(value string) bool {
	if len(value) != 3 {
		return false
	}
	for _, char := range value {
		if char < 'A' || char > 'Z' {
			return false
		}
	}
	return true
}

func isSubscriptionListRenewal(value string) bool {
	switch value {
	case "auto", "manual", "one-time":
		return true
	default:
		return false
	}
}

func isSubscriptionListReminderMode(value string) bool {
	switch value {
	case "disabled", "inherit", "custom":
		return true
	default:
		return false
	}
}
