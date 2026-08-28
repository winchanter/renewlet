// use-billing-records 测试保护分页扁平化、空态禁用和编辑成功后的缓存回写行为。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { ApiBillingRecord } from "@renewlet/shared/schemas/billing-records";
import type { BillingRecordsPage } from "@/services/billing-record-service";
import { subscriptionQueryKeys } from "./subscription-query-cache";
import { useBillingRecords, useUpdateBillingRecord } from "./use-billing-records";

const mocks = vi.hoisted(() => ({
  listBillingRecords: vi.fn(),
  updateBillingRecord: vi.fn(),
}));

vi.mock("@/services/billing-record-service", () => ({
  listBillingRecords: mocks.listBillingRecords,
  updateBillingRecord: mocks.updateBillingRecord,
}));

function apiRecord(overrides: Partial<ApiBillingRecord> = {}): ApiBillingRecord {
  return {
    id: "record-1",
    subscriptionId: "sub-1",
    name: "Service",
    billingDate: "2026-01-01",
    periodEndDate: "2026-02-01",
    amount: "10",
    currency: "USD",
    mode: "initial",
    billingCycle: "monthly",
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    queryClient,
    wrapper: function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
}

describe("useBillingRecords", () => {
  beforeEach(() => {
    mocks.listBillingRecords.mockReset();
    mocks.updateBillingRecord.mockReset();
  });

  it("keeps the query idle without a subscription id and never requests records", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBillingRecords(null), { wrapper });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));

    expect(result.current.records).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(mocks.listBillingRecords).not.toHaveBeenCalled();
  });

  it("flattens loaded pages and reports the first page total", async () => {
    const pageOne: BillingRecordsPage = {
      records: [apiRecord({ id: "record-1", billingDate: "2026-02-01" })],
      nextCursor: "2026-02-01~record-1",
      total: 2,
    };
    const pageTwo: BillingRecordsPage = {
      records: [apiRecord({ id: "record-0", billingDate: "2026-01-01" })],
      nextCursor: null,
      total: 2,
    };
    mocks.listBillingRecords.mockImplementation(
      (_subscriptionId: string, options?: { cursor?: string | null }) =>
        options?.cursor ? Promise.resolve(pageTwo) : Promise.resolve(pageOne),
    );
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBillingRecords("sub-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.records.map((record) => record.id)).toEqual(["record-1"]);
    expect(result.current.total).toBe(2);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    // React Query v5 的通知经调度器异步落地，act 退出时组件可能尚未重渲染，断言交给 waitFor 兜底。
    await waitFor(() =>
      expect(result.current.records.map((record) => record.id)).toEqual(["record-1", "record-0"]),
    );
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe("useUpdateBillingRecord", () => {
  beforeEach(() => {
    mocks.listBillingRecords.mockReset();
    mocks.updateBillingRecord.mockReset();
  });

  it("writes the returned record into the paginated cache and marks it stale", async () => {
    const pageOne: BillingRecordsPage = {
      records: [apiRecord({ id: "record-1", amount: "10" })],
      nextCursor: "cursor-1",
      total: 2,
    };
    const pageTwo: BillingRecordsPage = {
      records: [apiRecord({ id: "record-2", amount: "8" })],
      nextCursor: null,
      total: 2,
    };
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData<InfiniteData<BillingRecordsPage>>(
      subscriptionQueryKeys.billingRecords("sub-1"),
      { pages: [pageOne, pageTwo], pageParams: [null, "cursor-1"] },
    );
    mocks.updateBillingRecord.mockResolvedValue(apiRecord({ id: "record-2", amount: "12" }));
    const { result } = renderHook(() => useUpdateBillingRecord(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ recordId: "record-2", patch: { amount: "12" } });
    });

    const cached = queryClient.getQueryData<InfiniteData<BillingRecordsPage>>(
      subscriptionQueryKeys.billingRecords("sub-1"),
    );
    const flattened = cached?.pages.flatMap((page) => page.records) ?? [];
    expect(flattened.find((record) => record.id === "record-2")?.amount).toBe("12");
    expect(flattened.find((record) => record.id === "record-1")?.amount).toBe("10");
    expect(queryClient.getQueryState(subscriptionQueryKeys.billingRecords("sub-1"))?.isInvalidated).toBe(true);
  });
});
