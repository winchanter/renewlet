import type { QueryClient } from "@tanstack/react-query";
import type { DateOnly } from "@/lib/time/date-only";
import type { SubscriptionListFilters } from "@/services/subscription-service";

const EMPTY_FILTERS: SubscriptionListFilters = {};

function queryFilters(filters?: SubscriptionListFilters): SubscriptionListFilters {
  return filters ?? EMPTY_FILTERS;
}

export const subscriptionQueryKeys = {
  all: ["subscriptions"] as const,
  collections: ["subscriptions", "collections"] as const,
  page: (filters?: SubscriptionListFilters) => ["subscriptions", "collections", "page", queryFilters(filters)] as const,
  index: (filters?: SubscriptionListFilters) => ["subscriptions", "collections", "index", queryFilters(filters)] as const,
  analytics: ["subscriptions", "collections", "analytics"] as const,
  calendar: (from: DateOnly, to: DateOnly) => ["subscriptions", "collections", "calendar", from, to] as const,
  facets: ["subscriptions", "collections", "facets"] as const,
  details: ["subscriptions", "details"] as const,
  detail: (id: string) => ["subscriptions", "details", id] as const,
  /** 扣费记录按订阅隔离；只随该订阅的创建/续订失效，不挂 collections 前缀避免整页重刷。 */
  billingRecords: (subscriptionId: string) => ["subscriptions", "billingRecords", subscriptionId] as const,
};

export function invalidateSubscriptionCollections(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.collections });
}

export function invalidateSubscriptionBillingRecords(queryClient: QueryClient, subscriptionId: string) {
  return queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.billingRecords(subscriptionId) });
}

/** 备份恢复会跨订阅重放流水：调用方没有单订阅粒度，统一失效全部扣费记录查询。 */
export function invalidateAllSubscriptionBillingRecords(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: ["subscriptions", "billingRecords"] });
}

export function removeSubscriptionDetails(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: subscriptionQueryKeys.details });
}

export function clearSubscriptionQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: subscriptionQueryKeys.all });
}
