// billing-record-service 测试保护未登录短路、分页参数收敛与 PATCH 请求契约。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BILLING_RECORD_QUERY_DEFAULT_LIMIT, type ApiBillingRecord } from "@renewlet/shared/schemas/billing-records";
import { listBillingRecords, updateBillingRecord } from "./billing-record-service";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getCurrentUserId: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@/lib/pocketbase", () => ({
  pb: {
    lang: "zh-CN",
    beforeSend: undefined,
  },
  getCurrentUserId: mocks.getCurrentUserId,
}));

function apiRecord(overrides: Partial<ApiBillingRecord> = {}): ApiBillingRecord {
  return {
    id: "record-1",
    subscriptionId: "sub-1",
    name: "Service",
    billingDate: "2026-01-01",
    periodEndDate: "2026-02-01",
    amount: "10.5",
    currency: "USD",
    mode: "initial",
    billingCycle: "monthly",
    ...overrides,
  };
}

describe("billing-record-service", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.getCurrentUserId.mockReset();
    mocks.getCurrentUserId.mockReturnValue("user-1");
  });

  it("returns an empty page without an authenticated user instead of calling the API", async () => {
    mocks.getCurrentUserId.mockReturnValue(null);

    const page = await listBillingRecords("sub-1");

    expect(page).toEqual({ records: [], nextCursor: null, total: 0 });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("requests the first page with the default limit and maps record dates", async () => {
    mocks.apiFetch.mockResolvedValue({
      records: [apiRecord()],
      nextCursor: null,
      total: 1,
    });

    const page = await listBillingRecords("sub-1");

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe(
      `/api/app/subscriptions/sub-1/billing-records?limit=${BILLING_RECORD_QUERY_DEFAULT_LIMIT}`,
    );
    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeNull();
    expect(page.records[0]).toMatchObject({ id: "record-1", billingDate: "2026-01-01", periodEndDate: "2026-02-01" });
  });

  it("forwards the cursor and clamps the page limit to the server maximum", async () => {
    mocks.apiFetch.mockResolvedValue({ records: [], nextCursor: null, total: 0 });

    await listBillingRecords("sub-1", { cursor: "2026-01-01~record-1", limit: 500 });

    const url = String(mocks.apiFetch.mock.calls[0]?.[0]);
    expect(url).toContain("limit=100");
    expect(url).toContain("cursor=2026-01-01%7Erecord-1");
  });

  it("rejects record updates without an authenticated user before touching the API", async () => {
    mocks.getCurrentUserId.mockReturnValue(null);

    await expect(updateBillingRecord("record-1", { amount: "12" })).rejects.toThrow();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("sends a PATCH body and returns the mapped record", async () => {
    const updated = apiRecord({ amount: "12" });
    mocks.apiFetch.mockResolvedValue({ record: updated });

    const record = await updateBillingRecord("record-1", { amount: "12", billingDate: "2026-01-02" });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/billing-records/record-1");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toEqual({
      method: "PATCH",
      body: JSON.stringify({ amount: "12", billingDate: "2026-01-02" }),
    });
    expect(record).toMatchObject({ id: "record-1", amount: "12", billingDate: "2026-01-01" });
  });
});
