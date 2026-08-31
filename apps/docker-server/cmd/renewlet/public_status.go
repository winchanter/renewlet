package main

// public_status.go 管理公开展示页。
//
// 架构位置：
//   - 登录态 API 负责生成、复制、金额开关和撤销公开页 URL。
//   - 公开 API 只靠高熵 token 定位用户，并返回严格 allowlist 的订阅状态投影。
//   - 私有 Logo 通过公开资产代理读取，代理每次都重新校验 token、owner 和可见订阅引用。
import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	publicStatusSubscriptionLimit    = 500
	publicStatusSubscriptionPageSize = 500
)

// publicStatusPageStatus 是登录用户设置页看到的公开展示页状态。
// PageURL 是唯一可复制凭据；token 不拆字段出站，避免进入 settings/export 等持久配置。
type publicStatusPageStatus struct {
	Enabled      bool   `json:"enabled"`
	CreatedAt    string `json:"createdAt,omitempty"`
	PageURL      string `json:"pageUrl,omitempty"`
	ShowPrices   bool   `json:"showPrices"`
	VaultEnabled bool   `json:"vaultEnabled"`
	UpdatedAt    string `json:"updatedAt,omitempty"`
}

// publicStatusPageStatusResponse 保持 settings 页读取的 root key；前端 schema 依赖 publicStatusPage 包裹层。
type publicStatusPageStatusResponse struct {
	PublicStatusPage publicStatusPageStatus `json:"publicStatusPage"`
}

// publicStatusPageCreateStatus 是创建/复用 token 后的完整状态。
type publicStatusPageCreateStatus struct {
	Enabled      bool   `json:"enabled"`
	CreatedAt    string `json:"createdAt"`
	PageURL      string `json:"pageUrl"`
	ShowPrices   bool   `json:"showPrices"`
	VaultEnabled bool   `json:"vaultEnabled"`
	UpdatedAt    string `json:"updatedAt"`
}

// publicStatusPageCreateResponse 与读取响应保持同一 root key，避免创建后缓存写入需要单独分支。
type publicStatusPageCreateResponse struct {
	PublicStatusPage publicStatusPageCreateStatus `json:"publicStatusPage"`
}

// publicStatusPageCreateRequest 只允许空对象；公开 token 始终由服务端生成。
type publicStatusPageCreateRequest struct{}

// publicStatusPageUpdateRequest 只允许切换公开开关（金额/账号访问），不允许客户端提交 token 或 URL。
type publicStatusPageUpdateRequest struct {
	ShowPrices   bool `json:"showPrices"`
	VaultEnabled bool `json:"vaultEnabled"`
}

// publicStatusResponse 是公开 API 的 allowlist 投影，不能直接返回订阅 record。
type publicStatusResponse struct {
	Page          publicStatusPageView           `json:"page"`
	Subscriptions []publicStatusSubscriptionView `json:"subscriptions"`
	Groups        []publicStatusGroupView        `json:"groups"`
	Vault         publicStatusVaultView          `json:"vault"`
}

// publicStatusPageView 描述公开页元信息；Currency 只有 showPrices=true 时才出现。
type publicStatusPageView struct {
	Title             string                   `json:"title"`
	ShowPrices        bool                     `json:"showPrices"`
	VaultEnabled      bool                     `json:"vaultEnabled"`
	Currency          string                   `json:"currency,omitempty"`
	ExchangeRateBasis *exchangeRatePublicBasis `json:"exchangeRateBasis,omitempty"`
	GeneratedAt       string                   `json:"generatedAt"`
	Truncated         bool                     `json:"truncated"`
}

// publicStatusVaultView 是公开页账号访问区块；Enabled=false 时 Subscriptions 必须为空。
type publicStatusVaultView struct {
	Enabled       bool                                `json:"enabled"`
	Subscriptions []publicStatusVaultSubscriptionView `json:"subscriptions"`
}

// publicStatusVaultSubscriptionView 只暴露申请访问必需的 id 与名称。
type publicStatusVaultSubscriptionView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// publicStatusSubscriptionView 是公开订阅字段白名单。
// 不包含订阅 id、备注、支付方式、提醒策略、tags、website、extra 或用户信息。
type publicStatusSubscriptionView struct {
	Name             string                   `json:"name"`
	Logo             string                   `json:"logo,omitempty"`
	Category         publicStatusCategoryView `json:"category"`
	Status           string                   `json:"status"`
	StartDate        *string                  `json:"startDate"`
	NextBillingDate  string                   `json:"nextBillingDate"`
	UpdatedAt        string                   `json:"updatedAt"`
	Price            *string                  `json:"price,omitempty"`
	Currency         string                   `json:"currency,omitempty"`
	BillingCycle     string                   `json:"billingCycle,omitempty"`
	CustomDays       int                      `json:"customDays,omitempty"`
	CustomCycleUnit  string                   `json:"customCycleUnit,omitempty"`
	OneTimeTermCount int                      `json:"oneTimeTermCount,omitempty"`
	OneTimeTermUnit  string                   `json:"oneTimeTermUnit,omitempty"`
	UsageTotal       float64                  `json:"usageTotal,omitempty"`
	UsageDailyRate   float64                  `json:"usageDailyRate,omitempty"`
	UsageExpiresAt   *string                  `json:"usageExpiresAt,omitempty"`
	// GroupIndex 是所属组在 Groups 数组中的下标；指针类型保证下标 0 正常输出，
	// 未分组订阅为 nil 并被 omitempty 省略。前端按下标回查组信息，不暴露组 id。
	GroupIndex *int `json:"groupIndex,omitempty"`
}

// publicStatusGroupView 是公开页订阅组投影；只暴露组名与 logo，不暴露组 id、描述与排序。
// 只输出至少含一条公开可见订阅的组，避免空组名泄露服务结构。
type publicStatusGroupView struct {
	Name string `json:"name"`
	Logo string `json:"logo,omitempty"`
}

// publicStatusCategoryView 只暴露展示标签和颜色，隐藏用户自定义配置的其它原始字段。
type publicStatusCategoryView struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Color string `json:"color,omitempty"`
}

// publicStatusCategoryResolver 把分类 value 映射成当前 locale 下的公开展示标签。
type publicStatusCategoryResolver struct {
	locale  appLocale
	byValue map[string]customConfigItem
}

func handlePublicStatusPageStatus(app core.App, e *core.RequestEvent) error {
	record, err := findPublicStatusPageForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, publicStatusPageStatusResponse{PublicStatusPage: publicStatusPageStatusFromRecord(e.Request, record)})
}

func handlePublicStatusPageCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	if _, err := decodeStrictJSON[publicStatusPageCreateRequest](e.Request, locale); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := ensurePublicStatusPage(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	// 创建接口可重复调用；已存在 token 时只回显状态，避免刷新页面意外轮换公开 URL。
	return apiSuccessJSON(e, http.StatusOK, publicStatusPageCreateResponse{PublicStatusPage: publicStatusPageCreateStatus{
		Enabled:      true,
		CreatedAt:    record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
		PageURL:      publicStatusPageURL(e.Request, record.GetString("token")),
		ShowPrices:   record.GetBool("showPrices"),
		VaultEnabled: record.GetBool("vaultEnabled"),
		UpdatedAt:    record.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}})
}

func handlePublicStatusPageUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[publicStatusPageUpdateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := findPublicStatusPageForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	if record == nil {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	record.Set("showPrices", body.ShowPrices)
	record.Set("vaultEnabled", body.VaultEnabled)
	if err := app.Save(record); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, publicStatusPageStatusResponse{PublicStatusPage: publicStatusPageStatusFromRecord(e.Request, record)})
}

func handlePublicStatusPageDelete(app core.App, e *core.RequestEvent) error {
	record, err := findPublicStatusPageForUser(app, e.Auth.Id)
	if err != nil {
		return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
	}
	if record != nil {
		// 撤销公开页只删除 token record；订阅自身 publicHidden 设置保留，便于用户之后重新开启沿用可见性选择。
		if err := app.Delete(record); err != nil {
			return e.InternalServerError(serverText(requestLocale(e.Request), "common.internalError"), err)
		}
	}
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func handlePublicStatusRead(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	token := strings.TrimSpace(e.Request.PathValue("token"))
	feed, err := findPublicStatusPageByToken(app, token)
	if err != nil {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	response, err := buildPublicStatusResponse(app, e.Request, feed)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	setPublicStatusHeaders(e.Response.Header())
	return apiSuccessJSON(e, http.StatusOK, response)
}

func handlePublicStatusAssetRead(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	token := strings.TrimSpace(e.Request.PathValue("token"))
	assetID := strings.TrimSpace(e.Request.PathValue("assetId"))
	page, err := findPublicStatusPageByToken(app, token)
	if err != nil || assetID == "" {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	asset, err := app.FindRecordById("assets", assetID)
	if err != nil || asset.GetString("user") != page.GetString("user") {
		return e.NotFoundError(serverText(locale, "common.notFound"), nil)
	}
	if ok, err := publicStatusAssetIsReferenced(app, page.GetString("user"), assetID); err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	} else if !ok {
		groupOK, err := publicStatusGroupAssetIsReferenced(app, page.GetString("user"), assetID)
		if err != nil {
			return e.InternalServerError(serverText(locale, "common.internalError"), err)
		}
		if !groupOK {
			// 公开资产 URL 不能成为同用户资产枚举器；只有可见订阅或其所属组实际引用的 Logo 才能被 token 读取。
			return e.NotFoundError(serverText(locale, "common.notFound"), nil)
		}
	}
	return writeAssetRecord(app, e, asset, "no-store", true)
}

func findPublicStatusPageForUser(app core.App, userID string) (*core.Record, error) {
	record, err := app.FindFirstRecordByFilter("public_status_pages", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		if errorsIsNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	return record, nil
}

func findPublicStatusPageByToken(app core.App, token string) (*core.Record, error) {
	if !publicStatusTokenRe.MatchString(token) {
		return nil, sql.ErrNoRows
	}
	record, err := app.FindFirstRecordByFilter("public_status_pages", "token = {:token}", dbx.Params{"token": token})
	if err != nil {
		// 公开页是 bearer URL；无效、撤销和猜测 token 一律同类 404，避免泄漏 token 是否接近有效。
		return nil, sql.ErrNoRows
	}
	return record, nil
}

func ensurePublicStatusPage(app core.App, userID string) (*core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("public_status_pages")
	if err != nil {
		return nil, err
	}
	record, err := findPublicStatusPageForUser(app, userID)
	if err != nil {
		return nil, err
	}
	if record == nil {
		record = core.NewRecord(collection)
		record.Set("user", userID)
		token, err := newCalendarFeedToken()
		if err != nil {
			return nil, err
		}
		record.Set("token", token)
		record.Set("showPrices", false)
		record.Set("vaultEnabled", false)
	}
	if err := app.Save(record); err != nil {
		return nil, err
	}
	return record, nil
}

func publicStatusPageStatusFromRecord(request *http.Request, record *core.Record) publicStatusPageStatus {
	if record == nil {
		return publicStatusPageStatus{Enabled: false, ShowPrices: false, VaultEnabled: false}
	}
	return publicStatusPageStatus{
		Enabled:      true,
		CreatedAt:    record.GetDateTime("created").Time().UTC().Format(time.RFC3339),
		PageURL:      publicStatusPageURL(request, record.GetString("token")),
		ShowPrices:   record.GetBool("showPrices"),
		VaultEnabled: record.GetBool("vaultEnabled"),
		UpdatedAt:    record.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}
}

func publicStatusPageURL(request *http.Request, token string) string {
	return externalRequestURL(request, "/status/"+token, nil)
}

func publicStatusAssetURL(request *http.Request, token string, assetID string) string {
	return externalRequestURL(request, "/api/public/status/"+token+"/assets/"+assetID, nil)
}

func buildPublicStatusResponse(app core.App, request *http.Request, page *core.Record) (publicStatusResponse, error) {
	userID := page.GetString("user")
	settings := publicStatusSettingsForUser(app, userID)
	resolver := newPublicStatusCategoryResolver(app, userID, normalizeAppLocale(settings.Locale))
	today := todayDateOnly(time.Now().UTC(), settings.Timezone)
	// 组投影在订阅之前构建：订阅按下标回查所属组，之后只保留被可见订阅引用的组。
	groupIndexByID, groupViews, err := publicStatusGroupsForUser(app, request, page)
	if err != nil {
		return publicStatusResponse{}, err
	}
	items, truncated, err := listPublicStatusSubscriptions(app, request, page, resolver, today, groupIndexByID)
	if err != nil {
		return publicStatusResponse{}, err
	}
	showPrices := page.GetBool("showPrices")
	vaultEnabled := page.GetBool("vaultEnabled")
	view := publicStatusPageView{
		Title:        "Renewo",
		ShowPrices:   showPrices,
		VaultEnabled: vaultEnabled,
		GeneratedAt:  time.Now().UTC().Format(time.RFC3339),
		Truncated:    truncated,
	}
	if showPrices {
		view.Currency = effectivePublicStatusCurrency(settings)
		basis := exchangeRatePublicBasisForUser(app, userID, time.Now().UTC())
		view.ExchangeRateBasis = &basis
	}
	vault := publicStatusVaultView{Enabled: vaultEnabled, Subscriptions: []publicStatusVaultSubscriptionView{}}
	if vaultEnabled {
		// 申请访问的选项口径与页面可见订阅一致（publicHidden=false）；仅暴露 id 与名称。
		rows, err := app.FindRecordsByFilter(
			"subscriptions",
			"user = {:user} && publicHidden = false",
			"-pinned,-created,-id",
			publicStatusSubscriptionLimit+1,
			0,
			dbx.Params{"user": userID},
		)
		if err != nil {
			return publicStatusResponse{}, err
		}
		for _, row := range rows {
			vault.Subscriptions = append(vault.Subscriptions, publicStatusVaultSubscriptionView{
				ID:   row.Id,
				Name: row.GetString("name"),
			})
		}
	}
	return publicStatusResponse{
		Page:          view,
		Subscriptions: items,
		Groups:        referencedPublicStatusGroups(items, groupViews),
		Vault:         vault,
	}, nil
}

// publicStatusGroupsForUser 拉取用户全部订阅组（sortOrder 升序，与组列表管理口径一致），
// 返回组 id → 下标映射和公开组投影（logo 走公开资产代理）。
func publicStatusGroupsForUser(app core.App, request *http.Request, page *core.Record) (map[string]int, []publicStatusGroupView, error) {
	userID := page.GetString("user")
	token := page.GetString("token")
	lookup := map[string]int{}
	groups := []publicStatusGroupView{}
	rows, err := app.FindRecordsByFilter(
		"subscription_groups",
		"user = {:user}",
		"sortOrder,created,id",
		publicStatusSubscriptionLimit, 0,
		dbx.Params{"user": userID},
	)
	if err != nil {
		return nil, nil, err
	}
	for _, row := range rows {
		lookup[row.Id] = len(groups)
		view := publicStatusGroupView{Name: row.GetString("name")}
		if logo := publicStatusLogoURL(request, token, row.GetString("logo")); logo != "" {
			view.Logo = logo
		}
		groups = append(groups, view)
	}
	return lookup, groups, nil
}

// referencedPublicStatusGroups 只保留被可见订阅引用的组，并把订阅投影中的组下标重映射到过滤后的位置。
func referencedPublicStatusGroups(items []publicStatusSubscriptionView, groups []publicStatusGroupView) []publicStatusGroupView {
	referenced := make([]bool, len(groups))
	for _, item := range items {
		if item.GroupIndex != nil && *item.GroupIndex >= 0 && *item.GroupIndex < len(groups) {
			referenced[*item.GroupIndex] = true
		}
	}
	remap := make([]int, len(groups))
	filtered := []publicStatusGroupView{}
	for index, keep := range referenced {
		if !keep {
			remap[index] = -1
			continue
		}
		remap[index] = len(filtered)
		filtered = append(filtered, groups[index])
	}
	if len(filtered) == len(groups) {
		return filtered
	}
	// items 与调用方共享底层数组；截断或空组过滤后统一重映射下标，未分组（nil）保持不变。
	for index := range items {
		if items[index].GroupIndex == nil {
			continue
		}
		current := *items[index].GroupIndex
		if current < 0 || current >= len(remap) {
			items[index].GroupIndex = nil
			continue
		}
		if remapped := remap[current]; remapped >= 0 {
			items[index].GroupIndex = &remapped
		} else {
			items[index].GroupIndex = nil
		}
	}
	return filtered
}

func listPublicStatusSubscriptions(app core.App, request *http.Request, page *core.Record, resolver publicStatusCategoryResolver, today string, groupIndexByID map[string]int) ([]publicStatusSubscriptionView, bool, error) {
	userID := page.GetString("user")
	token := page.GetString("token")
	items := []publicStatusSubscriptionView{}
	for offset := 0; ; offset += publicStatusSubscriptionPageSize {
		// 公开页顺序跟订阅列表默认口径一致；created/id 只参与内部排序，不能进入公开 allowlist。
		rows, err := app.FindRecordsByFilter(
			"subscriptions",
			"user = {:user} && publicHidden = false",
			"-pinned,-created,-id",
			publicStatusSubscriptionPageSize,
			offset,
			dbx.Params{"user": userID},
		)
		if err != nil {
			return nil, false, err
		}
		for _, row := range rows {
			items = append(items, publicStatusSubscriptionFromRecord(request, token, row, resolver, page.GetBool("showPrices"), today, groupIndexByID))
			if len(items) > publicStatusSubscriptionLimit {
				return items[:publicStatusSubscriptionLimit], true, nil
			}
		}
		if len(rows) < publicStatusSubscriptionPageSize {
			return items, false, nil
		}
	}
}

func publicStatusSubscriptionFromRecord(request *http.Request, token string, row *core.Record, resolver publicStatusCategoryResolver, showPrices bool, today string, groupIndexByID map[string]int) publicStatusSubscriptionView {
	item := publicStatusSubscriptionView{
		Name:            row.GetString("name"),
		Logo:            publicStatusLogoURL(request, token, row.GetString("logo")),
		Category:        resolver.Category(row.GetString("category")),
		Status:          publicStatusEffectiveStatus(row, today),
		StartDate:       nullableStringPointer(row.GetString("startDate")),
		NextBillingDate: row.GetString("nextBillingDate"),
		UpdatedAt:       row.GetDateTime("updated").Time().UTC().Format(time.RFC3339),
	}
	if groupID := row.GetString("group"); groupID != "" {
		if index, ok := groupIndexByID[groupID]; ok {
			// 下标指向 groups 数组；组随后只保留被引用项，由 referencedPublicStatusGroups 重映射。
			item.GroupIndex = &index
		}
	}
	if showPrices {
		price := moneyForRecord(row.Get("price"))
		item.Price = &price
		item.Currency = row.GetString("currency")
		item.BillingCycle = row.GetString("billingCycle")
		if row.GetInt("customDays") > 0 {
			item.CustomDays = row.GetInt("customDays")
		}
		if row.GetString("customCycleUnit") != "" {
			item.CustomCycleUnit = row.GetString("customCycleUnit")
		}
		if row.GetInt("oneTimeTermCount") > 0 {
			item.OneTimeTermCount = row.GetInt("oneTimeTermCount")
		}
		if row.GetString("oneTimeTermUnit") != "" {
			item.OneTimeTermUnit = row.GetString("oneTimeTermUnit")
		}
		if row.GetString("billingCycle") == "usage-based" {
			// 公开页投影只输出月均摊销所需字段；量包单位不在公开 allowlist。
			item.UsageTotal = row.GetFloat("usageTotal")
			item.UsageDailyRate = row.GetFloat("usageDailyRate")
			// 失效日参与 min(耗尽, 失效) 摊销口径；仅 usage-based 输出，其余周期必须省略。
			if expiry := strings.TrimSpace(row.GetString("usageExpiresAt")); expiry != "" {
				item.UsageExpiresAt = &expiry
			}
		}
	}
	return item
}

func nullableStringPointer(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func effectivePublicStatusCurrency(settings appSettings) string {
	if settings.PublicStatusCurrency != "inherit" && settingsCurrencyRe.MatchString(settings.PublicStatusCurrency) {
		return settings.PublicStatusCurrency
	}
	if settingsCurrencyRe.MatchString(settings.DefaultCurrency) {
		return settings.DefaultCurrency
	}
	return "CNY"
}

func publicStatusEffectiveStatus(row *core.Record, today string) string {
	status := row.GetString("status")
	if status == "expired" {
		return "expired"
	}
	if row.GetString("billingCycle") == "one-time" && row.GetInt("oneTimeTermCount") <= 0 {
		return status
	}
	// 公开页是状态面板，必须沿用站内“有效状态”口径；过期兼容只改出站投影，不回写用户数据。
	if (status == "active" || status == "trial") && isValidDateOnly(row.GetString("nextBillingDate")) && row.GetString("nextBillingDate") < today {
		return "expired"
	}
	return status
}

func publicStatusLogoURL(request *http.Request, token string, value string) string {
	logo := strings.TrimSpace(value)
	if logo == "" {
		return ""
	}
	if privateAssetPathRe.MatchString(logo) {
		assetID := strings.TrimPrefix(logo, "/api/app/assets/")
		return publicStatusAssetURL(request, token, assetID)
	}
	return logo
}

func publicStatusAssetIsReferenced(app core.App, userID string, assetID string) (bool, error) {
	logo := "/api/app/assets/" + assetID
	record, err := app.FindFirstRecordByFilter(
		"subscriptions",
		"user = {:user} && publicHidden = false && logo = {:logo}",
		dbx.Params{"user": userID, "logo": logo},
	)
	if err != nil {
		if errorsIsNoRows(err) {
			return false, nil
		}
		return false, err
	}
	return record != nil, nil
}

// publicStatusGroupAssetIsReferenced 校验组 logo 引用：资产被某组 logo 引用，且该组下至少有一条公开可见订阅。
func publicStatusGroupAssetIsReferenced(app core.App, userID string, assetID string) (bool, error) {
	logo := "/api/app/assets/" + assetID
	groups, err := app.FindRecordsByFilter(
		"subscription_groups",
		"user = {:user} && logo = {:logo}",
		"created,id",
		publicStatusSubscriptionLimit, 0,
		dbx.Params{"user": userID, "logo": logo},
	)
	if err != nil {
		return false, err
	}
	for _, group := range groups {
		subscription, err := app.FindFirstRecordByFilter(
			"subscriptions",
			"group = {:group} && user = {:user} && publicHidden = false",
			dbx.Params{"group": group.Id, "user": userID},
		)
		if err != nil {
			if errorsIsNoRows(err) {
				continue
			}
			return false, err
		}
		if subscription != nil {
			return true, nil
		}
	}
	return false, nil
}

func publicStatusSettingsForUser(app core.App, userID string) appSettings {
	settings := defaultAppSettings()
	record, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		return settings
	}
	return settingsFromRecord(record)
}

func newPublicStatusCategoryResolver(app core.App, userID string, locale appLocale) publicStatusCategoryResolver {
	resolver := publicStatusCategoryResolver{
		locale:  locale,
		byValue: map[string]customConfigItem{},
	}
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": userID})
	if err != nil {
		return resolver
	}
	config, err := customConfigFromValue(record.Get("config"))
	if err != nil {
		return resolver
	}
	for _, item := range config.Categories {
		resolver.byValue[item.Value] = item
	}
	return resolver
}

func (r publicStatusCategoryResolver) Category(value string) publicStatusCategoryView {
	item, ok := r.byValue[value]
	if ok {
		return publicStatusCategoryView{
			Value: value,
			Label: publicStatusLocalizedConfigLabel(item.Labels, r.locale, value),
			Color: item.Color,
		}
	}
	if key, ok := calendarFeedBuiltInCategoryLabelKey(value); ok {
		return publicStatusCategoryView{Value: value, Label: serverText(r.locale, key)}
	}
	return publicStatusCategoryView{Value: value, Label: value}
}

func publicStatusLocalizedConfigLabel(labels customConfigLabels, locale appLocale, fallback string) string {
	if locale == localeEnUS {
		if labels.EnUS != "" {
			return labels.EnUS
		}
		if labels.ZhCN != "" {
			return labels.ZhCN
		}
		return fallback
	}
	if labels.ZhCN != "" {
		return labels.ZhCN
	}
	if labels.EnUS != "" {
		return labels.EnUS
	}
	return fallback
}

func setPublicStatusHeaders(headers http.Header) {
	headers.Set("Cache-Control", "no-store")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Robots-Tag", "noindex, nofollow")
}
