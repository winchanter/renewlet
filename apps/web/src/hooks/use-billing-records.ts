import { useMemo } from "react";
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryFunctionContext,
} from "@tanstack/react-query";
import {
  listBillingRecords,
  updateBillingRecord,
  type BillingRecordsPage,
} from "@/services/billing-record-service";
import { subscriptionQueryKeys } from "@/hooks/subscription-query-cache";
import type { ApiBillingRecord, BillingRecordPatchBody } from "@renewlet/shared/schemas/billing-records";

const BILLING_RECORDS_STALE_TIME_MS = 60_000;
const INITIAL_BILLING_RECORDS_CURSOR: string | null = null;

export function billingRecordsInfiniteQueryOptions(subscriptionId: string) {
  const queryKey = subscriptionQueryKeys.billingRecords(subscriptionId);
  return infiniteQueryOptions({
    queryKey,
    initialPageParam: INITIAL_BILLING_RECORDS_CURSOR,
    queryFn: ({ pageParam, signal }: QueryFunctionContext<typeof queryKey, string | null>) =>
      listBillingRecords(subscriptionId, { cursor: pageParam ?? undefined, signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: BILLING_RECORDS_STALE_TIME_MS,
  });
}

/** 历史弹窗按需加载；未订阅 id 时保持空闲，避免空 key 请求。 */
export function useBillingRecords(subscriptionId: string | null, enabled = true) {
  const query = useInfiniteQuery({
    ...billingRecordsInfiniteQueryOptions(subscriptionId ?? ""),
    enabled: enabled && Boolean(subscriptionId),
  });
  const records = useMemo(
    () => query.data?.pages.flatMap((page) => page.records) ?? [],
    [query.data?.pages],
  );
  return {
    ...query,
    records,
    total: query.data?.pages[0]?.total ?? 0,
  };
}

/** 编辑成功先用服务端回包就地替换对应行，再把分页缓存标记为过期，让游标序与 total 在下次交互时校正。 */
function writeBillingRecordPatchResult(queryClient: QueryClient, record: ApiBillingRecord): void {
  queryClient.setQueryData<InfiniteData<BillingRecordsPage>>(
    subscriptionQueryKeys.billingRecords(record.subscriptionId),
    (current: InfiniteData<BillingRecordsPage> | undefined) => {
      if (!current) return current;
      return {
        ...current,
        pages: current.pages.map((page: BillingRecordsPage) => ({
          ...page,
          records: page.records.map((item: ApiBillingRecord) => (item.id === record.id ? record : item)),
        })),
      };
    },
  );
  void queryClient.invalidateQueries({
    queryKey: subscriptionQueryKeys.billingRecords(record.subscriptionId),
    refetchType: "none",
  });
}

export interface UpdateBillingRecordCommand {
  recordId: string;
  patch: BillingRecordPatchBody;
}

export function useUpdateBillingRecord() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId, patch }: UpdateBillingRecordCommand) => updateBillingRecord(recordId, patch),
    onSuccess: (record) => writeBillingRecordPatchResult(queryClient, record),
  });
}
