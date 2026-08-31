import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { apiFetch } from "@/lib/api-client";
import { getCurrentUserId } from "@/lib/pocketbase";
import {
  subscriptionGroupDeleteResponseSchema,
  subscriptionGroupResponseSchema,
  subscriptionGroupStatsResponseSchema,
  subscriptionGroupsListResponseSchema,
  type SubscriptionGroup,
  type SubscriptionGroupCreateRequest,
  type SubscriptionGroupStats,
  type SubscriptionGroupUpdateRequest,
} from "@renewlet/shared/schemas/subscription-groups";

/**
 * 订阅组服务。
 *
 * 组表示"同一个大服务下的多个订阅"，与 category（粗分类）并存。
 * 只服务 Go/Docker 运行面。
 */

export async function listSubscriptionGroups(signal?: AbortSignal): Promise<SubscriptionGroup[]> {
  if (!getCurrentUserId()) return [];
  const data = await apiFetch(
    "/api/app/subscription-groups",
    subscriptionGroupsListResponseSchema,
    signal ? { signal } : undefined,
  );
  return data.groups;
}

export async function createSubscriptionGroup(
  body: SubscriptionGroupCreateRequest,
  signal?: AbortSignal,
): Promise<SubscriptionGroup> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch("/api/app/subscription-groups", subscriptionGroupResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal ? { signal } : undefined),
  });
  return data;
}

export async function readSubscriptionGroup(groupId: string, signal?: AbortSignal): Promise<SubscriptionGroup> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch(
    `/api/app/subscription-groups/${encodeURIComponent(groupId)}`,
    subscriptionGroupResponseSchema,
    signal ? { signal } : undefined,
  );
  return data;
}

export async function updateSubscriptionGroup(
  groupId: string,
  patch: SubscriptionGroupUpdateRequest,
  signal?: AbortSignal,
): Promise<SubscriptionGroup> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch(
    `/api/app/subscription-groups/${encodeURIComponent(groupId)}`,
    subscriptionGroupResponseSchema,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
      ...(signal ? { signal } : undefined),
    },
  );
  return data;
}

export async function deleteSubscriptionGroup(groupId: string, signal?: AbortSignal): Promise<void> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  await apiFetch(
    `/api/app/subscription-groups/${encodeURIComponent(groupId)}`,
    subscriptionGroupDeleteResponseSchema,
    {
      method: "DELETE",
      ...(signal ? { signal } : undefined),
    },
  );
}

export async function readSubscriptionGroupStats(groupId: string, signal?: AbortSignal): Promise<SubscriptionGroupStats> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch(
    `/api/app/subscription-groups/${encodeURIComponent(groupId)}/stats`,
    subscriptionGroupStatsResponseSchema,
    signal ? { signal } : undefined,
  );
  return data;
}
