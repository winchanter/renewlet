package main

// subscription_billing_records_test.go 保护扣费记录的生成边界与 API 契约：
// 创建/手动续订/自动续订在同一事务产出记录快照，list 走 (billing_date, id) keyset 分页并做 owner 过滤，
// patch 只开放事实修正字段，归属与来源字段在严格解码层直接拒绝。

import (
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func setupBillingRecordsTestApp(t *testing.T, role string) (core.App, *core.Record, string) {
	t.Helper()
	app := newSchemaTestApp(t)
	if err := ensureSchema(app); err != nil {
		t.Fatal(err)
	}
	registerRecordHooks(app)
	user, token := createRouteTestUser(t, app, role)
	return app, user, token
}

// createBillingRecordSubscriptionForTest 通过产品 API 创建订阅，保证 initial 扣费记录已随创建事务生成。
func createBillingRecordSubscriptionForTest(t *testing.T, app core.App, token string, name string) string {
	t.Helper()
	create := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions", subscriptionCreateBody(name), token)
	if create.Code != http.StatusCreated {
		t.Fatalf("expected subscription create 201, got %d: %s", create.Code, create.Body.String())
	}
	created := decodeAPISuccessDataForTest[subscriptionResponse](t, create.Body.Bytes())
	return created.Subscription.ID
}

func fetchBillingRecordsPageForTest(t *testing.T, app core.App, token string, subscriptionID string, query string) billingRecordsListResponse {
	t.Helper()
	target := "/api/app/subscriptions/" + subscriptionID + "/billing-records"
	if query != "" {
		target += "?" + query
	}
	res := serveTestRequest(t, app, http.MethodGet, target, "", token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected billing records list 200, got %d: %s", res.Code, res.Body.String())
	}
	return decodeAPISuccessDataForTest[billingRecordsListResponse](t, res.Body.Bytes())
}

func TestSubscriptionCreateWritesInitialBillingRecord(t *testing.T) {
	app, _, token := setupBillingRecordsTestApp(t, "billing-initial")
	subscriptionID := createBillingRecordSubscriptionForTest(t, app, token, "Billing Initial")

	page := fetchBillingRecordsPageForTest(t, app, token, subscriptionID, "")
	if page.Total != 1 || len(page.Records) != 1 || page.NextCursor != nil {
		t.Fatalf("expected single initial billing record, got %#v", page)
	}
	record := page.Records[0]
	if record.SubscriptionID != subscriptionID || record.Name != "Billing Initial" {
		t.Fatalf("expected identity snapshot from subscription, got %#v", record)
	}
	if record.Mode != billingRecordModeInitial || record.BillingDate != "2026-01-01" {
		t.Fatalf("expected initial record anchored at start date, got %#v", record)
	}
	if record.PeriodEndDate == nil || *record.PeriodEndDate != "2026-02-01" {
		t.Fatalf("expected initial period end at next billing date, got %#v", record.PeriodEndDate)
	}
	if record.Amount != "12" || record.Currency != "USD" || record.BillingCycle != "monthly" {
		t.Fatalf("expected canonical money snapshot, got %#v", record)
	}
	if record.CustomDays != 0 || record.CustomCycleUnit != "" || record.OneTimeTermCount != 0 ||
		record.OneTimeTermUnit != "" || record.UsageUnit != "" || record.UsageTotal != 0 || record.UsageDailyRate != 0 {
		t.Fatalf("monthly record must not carry cycle-specific fields, got %#v", record)
	}
	res := serveTestRequest(t, app, http.MethodGet, "/api/app/subscriptions/"+subscriptionID+"/billing-records", "", token)
	// monthly 记录的周期专属字段必须从 wire shape 中完全省略，与 shared 的互斥 refine 保持同形。
	for _, field := range []string{`"customDays"`, `"customCycleUnit"`, `"oneTimeTermCount"`, `"oneTimeTermUnit"`, `"usageUnit"`, `"usageTotal"`, `"usageDailyRate"`} {
		if strings.Contains(res.Body.String(), field) {
			t.Fatalf("monthly record response must omit %s, got %s", field, res.Body.String())
		}
	}
}

func TestSubscriptionRenewContinueWritesManualContinueBillingRecord(t *testing.T) {
	app, user, token := setupBillingRecordsTestApp(t, "billing-continue")
	subscription := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":            "Continue Billing",
		"status":          "expired",
		"startDate":       "2026-01-31",
		"nextBillingDate": "2026-02-28",
		"autoRenew":       false,
	})

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+subscription.Id+"/renew", `{
		"mode":"continue",
		"price":"15.500000",
		"currency":"EUR",
		"startDate":null,
		"nextBillingDate":"2026-08-12",
		"autoCalculateNextBillingDate":false
	}`, token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected renew 200, got %d: %s", res.Code, res.Body.String())
	}
	renewed := decodeAPISuccessDataForTest[map[string]map[string]interface{}](t, res.Body.Bytes())
	newNextBillingDate, _ := renewed["subscription"]["nextBillingDate"].(string)
	if newNextBillingDate == "" {
		t.Fatalf("expected renewed next billing date, got %#v", renewed)
	}

	page := fetchBillingRecordsPageForTest(t, app, token, subscription.Id, "")
	if page.Total != 1 || len(page.Records) != 1 {
		t.Fatalf("expected single manual_continue record, got %#v", page)
	}
	record := page.Records[0]
	if record.Mode != billingRecordModeManualContinue {
		t.Fatalf("expected manual_continue mode, got %q", record.Mode)
	}
	// continue 的扣费日取推进前的旧到期日，区间终点是续订后的新到期日。
	if record.BillingDate != "2026-02-28" || record.PeriodEndDate == nil || *record.PeriodEndDate != newNextBillingDate {
		t.Fatalf("expected continue period [old next, new next], got %#v (new next %q)", record, newNextBillingDate)
	}
	// 快照取更新后的订阅：金额/币种是本次续订写下的值。
	if record.Amount != "15.5" || record.Currency != "EUR" {
		t.Fatalf("expected renewed money snapshot, got %#v", record)
	}
}

func TestSubscriptionRenewRestartWritesManualRestartBillingRecord(t *testing.T) {
	app, user, token := setupBillingRecordsTestApp(t, "billing-restart")
	subscription := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":                         "Restart Billing",
		"status":                       "expired",
		"startDate":                    "2026-01-01",
		"nextBillingDate":              "2026-02-01",
		"autoRenew":                    false,
		"autoCalculateNextBillingDate": false,
	})

	res := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+subscription.Id+"/renew", `{
		"mode":"restart",
		"price":"20",
		"currency":"USD",
		"startDate":"2026-08-12",
		"nextBillingDate":"2026-09-12",
		"autoCalculateNextBillingDate":true
	}`, token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected renew restart 200, got %d: %s", res.Code, res.Body.String())
	}

	page := fetchBillingRecordsPageForTest(t, app, token, subscription.Id, "")
	if page.Total != 1 || len(page.Records) != 1 {
		t.Fatalf("expected single manual_restart record, got %#v", page)
	}
	record := page.Records[0]
	if record.Mode != billingRecordModeManualRestart || record.BillingDate != "2026-08-12" {
		t.Fatalf("expected restart record anchored at new start date, got %#v", record)
	}
	if record.PeriodEndDate == nil || *record.PeriodEndDate != "2026-09-12" {
		t.Fatalf("expected restart period end at new next billing date, got %#v", record.PeriodEndDate)
	}
	if record.Amount != "20" || record.Currency != "USD" {
		t.Fatalf("expected restarted money snapshot, got %#v", record)
	}
}

func TestAutoRenewalWritesPerCycleBillingRecords(t *testing.T) {
	app, user, _ := setupBillingRecordsTestApp(t, "billing-auto")
	subscription := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name": "Auto Billing",
	})

	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	updated, err := renewAutoSubscriptionsForUser(app, user.Id, "UTC", now)
	if err != nil {
		t.Fatal(err)
	}
	if updated != 1 {
		t.Fatalf("expected one auto-renewed subscription, got %d", updated)
	}
	reloaded, err := app.FindRecordById("subscriptions", subscription.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.GetString("nextBillingDate") != "2026-04-01" {
		t.Fatalf("expected subscription advanced to 2026-04-01, got %q", reloaded.GetString("nextBillingDate"))
	}

	rows, err := app.FindRecordsByFilter(
		billingRecordsCollectionName,
		"user_id = {:user} && subscription_id = {:sub}",
		"billing_date",
		0,
		0,
		dbx.Params{"user": user.Id, "sub": subscription.Id},
	)
	if err != nil {
		t.Fatal(err)
	}
	// 2026-02-01 落后 today 两期：自动续订必须为覆盖的每一期各写一条记录。
	wantPeriods := [][2]string{{"2026-02-01", "2026-03-01"}, {"2026-03-01", "2026-04-01"}}
	if len(rows) != len(wantPeriods) {
		t.Fatalf("expected %d auto billing records, got %d", len(wantPeriods), len(rows))
	}
	for i, row := range rows {
		if got := row.GetString("mode"); got != billingRecordModeAuto {
			t.Fatalf("expected auto mode on row %d, got %q", i, got)
		}
		if got := row.GetString("billing_date"); got != wantPeriods[i][0] {
			t.Fatalf("expected billing date %s on row %d, got %q", wantPeriods[i][0], i, got)
		}
		if got := row.GetString("period_end_date"); got != wantPeriods[i][1] {
			t.Fatalf("expected period end %s on row %d, got %q", wantPeriods[i][1], i, got)
		}
		// 金额快照取推进前的订阅，而不是续订算法的任何动态值。
		if got := row.GetString("amount"); got != "12" {
			t.Fatalf("expected pre-renewal amount snapshot on row %d, got %q", i, got)
		}
	}
}

func TestSubscriptionBillingRecordsListPaginatesAndIsolatesOwners(t *testing.T) {
	app, user, token := setupBillingRecordsTestApp(t, "billing-pages")
	_, otherToken := createRouteTestUser(t, app, "billing-pages-other")
	subscription := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{
		"name":                         "Paged Billing",
		"status":                       "expired",
		"startDate":                    "2026-01-01",
		"nextBillingDate":              "2026-02-01",
		"autoRenew":                    false,
		"autoCalculateNextBillingDate": false,
	})

	// restart 模式显式指定日期：三次续订产出三条扣费日互不相同的记录，且断言不依赖真实时钟。
	restarts := [][2]string{{"2026-03-01", "2026-04-01"}, {"2026-04-01", "2026-05-01"}, {"2026-05-01", "2026-06-01"}}
	for _, pair := range restarts {
		body := `{"mode":"restart","price":"12","currency":"USD","startDate":"` + pair[0] + `","nextBillingDate":"` + pair[1] + `","autoCalculateNextBillingDate":true}`
		res := serveTestRequest(t, app, http.MethodPost, "/api/app/subscriptions/"+subscription.Id+"/renew", body, token)
		if res.Code != http.StatusOK {
			t.Fatalf("expected restart renew towards %s to return 200, got %d: %s", pair[1], res.Code, res.Body.String())
		}
	}

	firstPage := fetchBillingRecordsPageForTest(t, app, token, subscription.Id, "limit=2")
	if firstPage.Total != 3 || len(firstPage.Records) != 2 || firstPage.NextCursor == nil {
		t.Fatalf("expected first page with next cursor, got %#v", firstPage)
	}
	// 排序是 billing_date DESC + id DESC：第一页必须从最新扣费日开始。
	if firstPage.Records[0].BillingDate != "2026-05-01" || firstPage.Records[1].BillingDate != "2026-04-01" {
		t.Fatalf("expected descending billing dates on first page, got %#v", firstPage.Records)
	}

	secondPage := fetchBillingRecordsPageForTest(t, app, token, subscription.Id, "limit=2&cursor="+url.QueryEscape(*firstPage.NextCursor))
	if secondPage.Total != 3 || len(secondPage.Records) != 1 || secondPage.NextCursor != nil {
		t.Fatalf("expected final page without next cursor, got %#v", secondPage)
	}
	if secondPage.Records[0].BillingDate != "2026-03-01" {
		t.Fatalf("expected oldest record on second page, got %#v", secondPage.Records)
	}

	seen := map[string]bool{}
	for _, record := range append(append([]billingRecordItem{}, firstPage.Records...), secondPage.Records...) {
		if seen[record.ID] {
			t.Fatalf("cursor pagination repeated record %s", record.ID)
		}
		seen[record.ID] = true
	}

	// owner 隔离：别人的订阅列表是空集而不是 404，避免用错误码探测他人订阅是否存在。
	foreignPage := fetchBillingRecordsPageForTest(t, app, otherToken, subscription.Id, "")
	if foreignPage.Total != 0 || len(foreignPage.Records) != 0 || foreignPage.NextCursor != nil {
		t.Fatalf("expected foreign subscription records to be empty, got %#v", foreignPage)
	}
	foreignPatch := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+firstPage.Records[0].ID, `{"amount":"99"}`, otherToken)
	if foreignPatch.Code != http.StatusNotFound {
		t.Fatalf("expected foreign billing record patch 404, got %d: %s", foreignPatch.Code, foreignPatch.Body.String())
	}
}

func TestSubscriptionBillingRecordsListRejectsInvalidQuery(t *testing.T) {
	app, user, token := setupBillingRecordsTestApp(t, "billing-query")
	subscription := createRouteTestSubscription(t, app, user.Id, map[string]interface{}{"name": "Query Billing"})
	base := "/api/app/subscriptions/" + subscription.Id + "/billing-records"
	for _, query := range []string{
		"limit=0",
		"limit=101",
		"limit=abc",
		"foo=1",
		"limit=2&limit=3",
		"cursor=not-a-date~id",
		"cursor=" + url.QueryEscape("2026-01-01~"),
	} {
		res := serveTestRequest(t, app, http.MethodGet, base+"?"+query, "", token)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("expected invalid query %q to return 400, got %d: %s", query, res.Code, res.Body.String())
		}
	}
}

func TestBillingRecordPatchUpdatesAmountWithoutTouchingPeriod(t *testing.T) {
	app, _, token := setupBillingRecordsTestApp(t, "billing-patch-amount")
	subscriptionID := createBillingRecordSubscriptionForTest(t, app, token, "Patch Amount")
	page := fetchBillingRecordsPageForTest(t, app, token, subscriptionID, "")
	recordID := page.Records[0].ID

	res := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID, `{"amount":"18.500000"}`, token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected billing record patch 200, got %d: %s", res.Code, res.Body.String())
	}
	updated := decodeAPISuccessDataForTest[billingRecordResponse](t, res.Body.Bytes()).Record
	if updated.ID != recordID || updated.Amount != "18.5" {
		t.Fatalf("expected canonical patched amount, got %#v", updated)
	}
	// 金额不是周期影响字段：periodEndDate 必须保持生成时的真实续订结果，不能被重算覆盖。
	if updated.PeriodEndDate == nil || *updated.PeriodEndDate != "2026-02-01" {
		t.Fatalf("expected period end untouched by amount patch, got %#v", updated.PeriodEndDate)
	}
	if updated.BillingCycle != "monthly" || updated.Mode != billingRecordModeInitial {
		t.Fatalf("expected cycle and mode snapshot preserved, got %#v", updated)
	}
}

func TestBillingRecordPatchSwitchesToCustomCycleAndRecomputesPeriodEnd(t *testing.T) {
	app, _, token := setupBillingRecordsTestApp(t, "billing-patch-custom")
	subscriptionID := createBillingRecordSubscriptionForTest(t, app, token, "Patch Custom")
	page := fetchBillingRecordsPageForTest(t, app, token, subscriptionID, "")
	recordID := page.Records[0].ID

	res := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID, `{"billingCycle":"custom","customDays":10,"customCycleUnit":"day"}`, token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected custom cycle patch 200, got %d: %s", res.Code, res.Body.String())
	}
	updated := decodeAPISuccessDataForTest[billingRecordResponse](t, res.Body.Bytes()).Record
	if updated.BillingCycle != "custom" || updated.CustomDays != 10 || updated.CustomCycleUnit != "day" {
		t.Fatalf("expected custom cycle fields on patched record, got %#v", updated)
	}
	// 编辑后的到期日按“扣费日 + 一期”重算：2026-01-01 + 10 天。
	if updated.PeriodEndDate == nil || *updated.PeriodEndDate != "2026-01-11" {
		t.Fatalf("expected recomputed custom period end 2026-01-11, got %#v", updated.PeriodEndDate)
	}
	// 周期互斥：切到 custom 后 one-time/usage 字段必须从 wire shape 消失。
	for _, field := range []string{`"oneTimeTermCount"`, `"usageUnit"`} {
		if strings.Contains(res.Body.String(), field) {
			t.Fatalf("custom record response must omit %s, got %s", field, res.Body.String())
		}
	}
}

func TestBillingRecordPatchSwitchesToUsageBasedAndRecomputesPeriodEnd(t *testing.T) {
	app, _, token := setupBillingRecordsTestApp(t, "billing-patch-usage")
	subscriptionID := createBillingRecordSubscriptionForTest(t, app, token, "Patch Usage")
	page := fetchBillingRecordsPageForTest(t, app, token, subscriptionID, "")
	recordID := page.Records[0].ID

	res := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID, `{"billingCycle":"usage-based","usageUnit":"GB","usageTotal":30,"usageDailyRate":3}`, token)
	if res.Code != http.StatusOK {
		t.Fatalf("expected usage-based patch 200, got %d: %s", res.Code, res.Body.String())
	}
	updated := decodeAPISuccessDataForTest[billingRecordResponse](t, res.Body.Bytes()).Record
	if updated.BillingCycle != "usage-based" || updated.UsageUnit != "GB" || updated.UsageTotal != 30 || updated.UsageDailyRate != 3 {
		t.Fatalf("expected usage fields on patched record, got %#v", updated)
	}
	// 耗尽日 = 扣费日 + ceil(总量/日均) = 2026-01-01 + 10 天。
	if updated.PeriodEndDate == nil || *updated.PeriodEndDate != "2026-01-11" {
		t.Fatalf("expected usage period end 2026-01-11, got %#v", updated.PeriodEndDate)
	}
	if updated.CustomDays != 0 || strings.Contains(res.Body.String(), `"customDays"`) {
		t.Fatalf("usage-based record must not carry custom cycle fields, got %s", res.Body.String())
	}
}

func TestBillingRecordPatchRejectsInvalidPayloads(t *testing.T) {
	app, _, token := setupBillingRecordsTestApp(t, "billing-patch-invalid")
	_, otherToken := createRouteTestUser(t, app, "billing-patch-invalid-other")
	subscriptionID := createBillingRecordSubscriptionForTest(t, app, token, "Patch Invalid")
	page := fetchBillingRecordsPageForTest(t, app, token, subscriptionID, "")
	recordID := page.Records[0].ID

	cases := []string{
		`{}`,                                             // 空 patch：没有可应用的变更
		`{"name":"Renamed"}`,                             // 来源快照不可改，unknown field 直接拒绝
		`{"mode":"auto"}`,                                // 来源 mode 不可伪造
		`{"subscriptionId":"sub-elsewhere"}`,             // 归属不可迁移
		`{"amount":null}`,                                // 金额必填，显式 null 拒绝
		`{"currency":null}`,                              // 币种必填
		`{"amount":"1e3"}`,                               // 非 canonical 金额
		`{"currency":"usd"}`,                             // 小写币种代码
		`{"billingDate":"2026-13-01"}`,                   // 非法 date-only
		`{"billingCycle":"custom"}`,                      // 缺少成对 custom 字段
		`{"billingCycle":"usage-based","usageTotal":30}`, // 缺少 usageUnit/usageDailyRate
		`{"usageTotal":-1}`,                              // 用量必须为正数
	}
	for _, body := range cases {
		res := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID, body, token)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("expected invalid patch %s to return 400, got %d: %s", body, res.Code, res.Body.String())
		}
	}

	foreign := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID, `{"amount":"99"}`, otherToken)
	if foreign.Code != http.StatusNotFound {
		t.Fatalf("expected foreign billing record patch 404, got %d: %s", foreign.Code, foreign.Body.String())
	}

	// 全部拒绝之后记录必须保持生成时的原样。
	pageAfter := fetchBillingRecordsPageForTest(t, app, token, subscriptionID, "")
	if pageAfter.Total != 1 || pageAfter.Records[0].Amount != "12" || pageAfter.Records[0].BillingCycle != "monthly" {
		t.Fatalf("expected rejected patches to leave record untouched, got %#v", pageAfter)
	}
}

// TestReadReceiptAssetIds 锁定 PocketBase JSONField 的真实返回类型（types.JSONRaw，底层 []byte）：
// 旧实现用 raw.([]any) 断言，对 []byte 永远失败并返回空切片，导致历史记录的凭证缩略图无法展示。
func TestReadReceiptAssetIds(t *testing.T) {
	cases := []struct {
		name string
		raw  any
		want []string
	}{
		{"nil returns empty", nil, []string{}},
		// PocketBase JSONField 的真实返回类型是 types.JSONRaw（底层 []byte 的命名类型）；
		// case []byte 不匹配命名类型，只有 case types.JSONRaw 才能命中，否则凭证缩略图永远不显示。
		{"types.JSONRaw (real PocketBase JSONField)", types.JSONRaw([]byte(`["ogukzf504vf2e5m","ws0toofn2uqtuq6"]`)), []string{"ogukzf504vf2e5m", "ws0toofn2uqtuq6"}},
		{"types.JSONRaw single", types.JSONRaw([]byte(`["abc123"]`)), []string{"abc123"}},
		{"types.JSONRaw empty array", types.JSONRaw([]byte(`[]`)), []string{}},
		{"types.JSONRaw non-array (object)", types.JSONRaw([]byte(`{"a":1}`)), []string{}},
		{"types.JSONRaw invalid json", types.JSONRaw([]byte(`not json`)), []string{}},
		{"bare []byte (fallback path)", []byte(`["ogukzf504vf2e5m","ws0toofn2uqtuq6"]`), []string{"ogukzf504vf2e5m", "ws0toofn2uqtuq6"}},
		{"already unmarshaled []any", []any{"ogukzf504vf2e5m", "ws0toofn2uqtuq6"}, []string{"ogukzf504vf2e5m", "ws0toofn2uqtuq6"}},
		{"filters out non-string and empty items", []byte(`["ok",123,true,""]`), []string{"ok"}},
		{"unsupported type returns empty", 42, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := readReceiptAssetIds(c.raw)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("readReceiptAssetIds(%v) = %#v, want %#v", c.raw, got, c.want)
			}
		})
	}
}

// uploadReceiptAssetForTest 通过产品 API 上传凭证资产，返回 asset id。
func uploadReceiptAssetForTest(t *testing.T, app core.App, token string, filename string) string {
	t.Helper()
	// 上传校验按魔数嗅探 MIME，需真实 PNG 签名才能过白名单；测试只读回/删除，不渲染内容。
	upload := serveMultipartTestRequest(
		t,
		app,
		"/api/app/assets",
		token,
		map[string]string{"kind": "receipt"},
		"file",
		filename,
		"\x89PNG\r\n\x1a\n",
	)
	if upload.Code != http.StatusCreated {
		t.Fatalf("expected receipt upload 201, got %d: %s", upload.Code, upload.Body.String())
	}
	uploaded := decodeAPISuccessDataForTest[uploadAssetResponse](t, upload.Body.Bytes())
	return strings.TrimPrefix(uploaded.URL, "/api/app/assets/")
}

// TestBillingRecordPatchCleansRemovedReceiptAssets 锁定 PATCH 收窄 receiptAssetIds 时的存储清理契约：
// 被移除的凭证资产与记录更新在同一事务删除（级联删文件），保留的与缺失的不受影响。
func TestBillingRecordPatchCleansRemovedReceiptAssets(t *testing.T) {
	app, _, token := setupBillingRecordsTestApp(t, "billing-patch-receipts")
	subscriptionID := createBillingRecordSubscriptionForTest(t, app, token, "Patch Receipts")
	page := fetchBillingRecordsPageForTest(t, app, token, subscriptionID, "")
	recordID := page.Records[0].ID
	receiptA := uploadReceiptAssetForTest(t, app, token, "receipt-a.png")
	receiptB := uploadReceiptAssetForTest(t, app, token, "receipt-b.png")

	attach := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID,
		`{"receiptAssetIds":["`+receiptA+`","`+receiptB+`"]}`, token)
	if attach.Code != http.StatusOK {
		t.Fatalf("expected receipt attach patch 200, got %d: %s", attach.Code, attach.Body.String())
	}

	// 移除 A：A 的资产行与文件应被删除，B 保留可读。
	shrink := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID,
		`{"receiptAssetIds":["`+receiptB+`"]}`, token)
	if shrink.Code != http.StatusOK {
		t.Fatalf("expected receipt shrink patch 200, got %d: %s", shrink.Code, shrink.Body.String())
	}
	if readA := serveTestRequest(t, app, http.MethodGet, "/api/app/assets/"+receiptA, "", token); readA.Code != http.StatusNotFound {
		t.Fatalf("expected removed receipt asset A deleted, got %d: %s", readA.Code, readA.Body.String())
	}
	if readB := serveTestRequest(t, app, http.MethodGet, "/api/app/assets/"+receiptB, "", token); readB.Code != http.StatusOK {
		t.Fatalf("expected kept receipt asset B readable, got %d: %s", readB.Code, readB.Body.String())
	}

	// 清空后 B 也应被清理；重复空 PATCH 幂等（资产缺失不阻塞编辑）。
	clear := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID, `{"receiptAssetIds":[]}`, token)
	if clear.Code != http.StatusOK {
		t.Fatalf("expected receipt clear patch 200, got %d: %s", clear.Code, clear.Body.String())
	}
	if readB := serveTestRequest(t, app, http.MethodGet, "/api/app/assets/"+receiptB, "", token); readB.Code != http.StatusNotFound {
		t.Fatalf("expected cleared receipt asset B deleted, got %d: %s", readB.Code, readB.Body.String())
	}
	again := serveTestRequest(t, app, http.MethodPatch, "/api/app/billing-records/"+recordID, `{"receiptAssetIds":[]}`, token)
	if again.Code != http.StatusOK {
		t.Fatalf("expected repeated empty receipt patch 200, got %d: %s", again.Code, again.Body.String())
	}
}
