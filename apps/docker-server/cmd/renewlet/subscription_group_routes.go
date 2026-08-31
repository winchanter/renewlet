package main

// subscription_group_routes.go 承载订阅组（Subscription Group）的产品 API。
//
// 架构位置：
//   - 组是"同一个大服务下多个订阅"的归属实体，与 category（粗分类文本）并存。
//   - 组 CRUD 只服务 Go/Docker 运行面；Cloudflare Worker 暂不实现。
//   - 删除组时不级联订阅/凭据，只把它们的 group 字段置空（PocketBase relation 不级联）。

import (
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type subscriptionGroupResponse struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Logo        *string `json:"logo"`
	Description *string `json:"description"`
	SortOrder   int     `json:"sortOrder"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

type subscriptionGroupsListResponse struct {
	Groups []subscriptionGroupResponse `json:"groups"`
}

type subscriptionGroupCreateRequest struct {
	Name        string  `json:"name"`
	Logo        *string `json:"logo"`
	Description *string `json:"description"`
	SortOrder   *int    `json:"sortOrder"`
}

type subscriptionGroupUpdateRequest struct {
	Name        *string `json:"name"`
	Logo        *string `json:"logo"`
	Description *string `json:"description"`
	SortOrder   *int    `json:"sortOrder"`
}

type subscriptionGroupStatsResponse struct {
	ID                string `json:"id"`
	SubscriptionCount int64  `json:"subscriptionCount"`
	CredentialCount   int64  `json:"credentialCount"`
	TotalMonthlyCost  string `json:"totalMonthlyCost"`
	Currency          string `json:"currency"`
}

func subscriptionGroupAPIFromRecord(record *core.Record) subscriptionGroupResponse {
	return subscriptionGroupResponse{
		ID:          record.Id,
		Name:        record.GetString("name"),
		Logo:        nullableString(record.GetString("logo")),
		Description: nullableString(record.GetString("description")),
		SortOrder:   record.GetInt("sortOrder"),
		CreatedAt:   record.GetDateTime("created").Time().UTC().Format("2006-01-02T15:04:05.999999999Z07:00"),
		UpdatedAt:   record.GetDateTime("updated").Time().UTC().Format("2006-01-02T15:04:05.999999999Z07:00"),
	}
}

func handleSubscriptionGroupsList(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	records, err := app.FindRecordsByFilter(
		"subscription_groups",
		"user = {:user}",
		"sortOrder, created, -id",
		0, 0,
		dbx.Params{"user": e.Auth.Id},
	)
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	groups := make([]subscriptionGroupResponse, 0, len(records))
	for _, record := range records {
		groups = append(groups, subscriptionGroupAPIFromRecord(record))
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionGroupsListResponse{Groups: groups})
}

func handleSubscriptionGroupCreate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[subscriptionGroupCreateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len([]rune(name)) > 120 {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
	}
	collection, err := app.FindCollectionByNameOrId("subscription_groups")
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	record := core.NewRecord(collection)
	record.Set("user", e.Auth.Id)
	record.Set("name", name)
	if body.Logo != nil {
		logo := strings.TrimSpace(*body.Logo)
		if logo != "" && len([]rune(logo)) > maxLogoReferenceLength {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		record.Set("logo", logo)
	}
	if body.Description != nil {
		desc := strings.TrimSpace(*body.Description)
		if len([]rune(desc)) > 500 {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		record.Set("description", desc)
	}
	if body.SortOrder != nil {
		record.Set("sortOrder", *body.SortOrder)
	} else {
		record.Set("sortOrder", 0)
	}
	if err := app.Save(record); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	return apiSuccessJSON(e, http.StatusCreated, subscriptionGroupAPIFromRecord(record))
}

func handleSubscriptionGroupRead(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findOwnedSubscriptionGroup(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "subscriptionGroup.notFound"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionGroupAPIFromRecord(record))
}

func handleSubscriptionGroupUpdate(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	body, err := decodeStrictJSON[subscriptionGroupUpdateRequest](e.Request, locale)
	if err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	record, err := findOwnedSubscriptionGroup(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "subscriptionGroup.notFound"), err)
	}
	if body.Name != nil {
		name := strings.TrimSpace(*body.Name)
		if name == "" || len([]rune(name)) > 120 {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		record.Set("name", name)
	}
	if body.Logo != nil {
		logo := strings.TrimSpace(*body.Logo)
		if logo != "" && len([]rune(logo)) > maxLogoReferenceLength {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		record.Set("logo", logo)
	}
	if body.Description != nil {
		desc := strings.TrimSpace(*body.Description)
		if len([]rune(desc)) > 500 {
			return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), nil)
		}
		record.Set("description", desc)
	}
	if body.SortOrder != nil {
		record.Set("sortOrder", *body.SortOrder)
	}
	if err := app.Save(record); err != nil {
		return e.BadRequestError(validationErrorMessage(locale, "common.invalidRequestBody", err), err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionGroupAPIFromRecord(record))
}

func handleSubscriptionGroupDelete(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findOwnedSubscriptionGroup(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "subscriptionGroup.notFound"), err)
	}
	// 删除组时订阅/凭据的 group relation 会被 PocketBase 自动置空（relation 不级联）。
	if err := app.Delete(record); err != nil {
		return e.BadRequestError(serverText(locale, "common.invalidRequestParameters"), err)
	}
	return apiEmptySuccessJSON(e, http.StatusOK)
}

func handleSubscriptionGroupStats(app core.App, e *core.RequestEvent) error {
	locale := requestLocale(e.Request)
	record, err := findOwnedSubscriptionGroup(app, e)
	if err != nil || record == nil {
		return e.NotFoundError(serverText(locale, "subscriptionGroup.notFound"), err)
	}
	groupID := record.Id
	subscriptionCount, err := countRecordsByFilter(app, "subscriptions", "group = {:group} && user = {:user}", dbx.Params{"group": groupID, "user": e.Auth.Id})
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	credentialCount, err := countRecordsByFilter(app, "vault_credentials", "group = {:group} && user = {:user}", dbx.Params{"group": groupID, "user": e.Auth.Id})
	if err != nil {
		return e.InternalServerError(serverText(locale, "common.internalError"), err)
	}
	return apiSuccessJSON(e, http.StatusOK, subscriptionGroupStatsResponse{
		ID:                groupID,
		SubscriptionCount: subscriptionCount,
		CredentialCount:   credentialCount,
		TotalMonthlyCost:  "0",
		Currency:          "USD",
	})
}

func findOwnedSubscriptionGroup(app core.App, e *core.RequestEvent) (*core.Record, error) {
	groupID := strings.TrimSpace(e.Request.PathValue("id"))
	return app.FindFirstRecordByFilter(
		"subscription_groups",
		"id = {:id} && user = {:user}",
		dbx.Params{"id": groupID, "user": e.Auth.Id},
	)
}

func countRecordsByFilter(app core.App, collection, filter string, params dbx.Params) (int64, error) {
	records, err := app.FindRecordsByFilter(collection, filter, "", 0, 0, params)
	if err != nil {
		return 0, err
	}
	return int64(len(records)), nil
}
