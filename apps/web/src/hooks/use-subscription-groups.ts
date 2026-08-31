import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  createSubscriptionGroup,
  deleteSubscriptionGroup,
  listSubscriptionGroups,
  updateSubscriptionGroup,
} from "@/services/subscription-group-service";
import type {
  SubscriptionGroup,
  SubscriptionGroupCreateRequest,
  SubscriptionGroupUpdateRequest,
} from "@renewlet/shared/schemas/subscription-groups";

const SUBSCRIPTION_GROUPS_STALE_TIME_MS = 60_000;

export const subscriptionGroupQueryKeys = {
  all: ["subscription-groups"] as const,
  list: () => [...subscriptionGroupQueryKeys.all, "list"] as const,
};

function invalidateSubscriptionGroups(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: subscriptionGroupQueryKeys.all });
}

export function useSubscriptionGroups(enabled = true) {
  const query = useQuery({
    queryKey: subscriptionGroupQueryKeys.list(),
    queryFn: ({ signal }) => listSubscriptionGroups(signal),
    enabled,
    staleTime: SUBSCRIPTION_GROUPS_STALE_TIME_MS,
  });
  const groups = useMemo(() => query.data ?? [], [query.data]);
  return { ...query, groups };
}

export function useCreateSubscriptionGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SubscriptionGroupCreateRequest) => createSubscriptionGroup(body),
    onSuccess: () => invalidateSubscriptionGroups(queryClient),
  });
}

export function useUpdateSubscriptionGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SubscriptionGroupUpdateRequest }) =>
      updateSubscriptionGroup(id, patch),
    onSuccess: () => invalidateSubscriptionGroups(queryClient),
  });
}

export function useDeleteSubscriptionGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSubscriptionGroup(id),
    onSuccess: () => invalidateSubscriptionGroups(queryClient),
  });
}

export type { SubscriptionGroup };
