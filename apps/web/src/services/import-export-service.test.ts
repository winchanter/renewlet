import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPORT_APPLY_SUBSCRIPTION_LIMIT } from "@/lib/api/schemas/import-export";
import type { ImportPayload } from "@/lib/api/schemas/import-export";
import { importExportService } from "./import-export-service";

function subscriptionPayload(index: number) {
  return {
    name: `Sub ${index}`,
    logo: null,
    price: "1",
    currency: "USD",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: null,
    startDate: "2026-05-21",
    nextBillingDate: "2026-06-21",
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: null,
    notes: null,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: { import: { source: "renewlet" as const, sourceId: `sub_${index}`, confidence: "high" as const } },
  };
}

function billingRecordPayload(subscriptionId: string) {
  return {
    id: `bill_${subscriptionId}`,
    subscriptionId,
    name: "Record Plan",
    billingDate: "2026-05-21",
    periodEndDate: "2026-06-21",
    amount: "1.00",
    currency: "USD",
    mode: "initial" as const,
    receiptAssetIds: [],
    billingCycle: "monthly" as const,
    usageRemainingBefore: null,
    usageExpiresAt: null,
  };
}

function applyData(payload: ImportPayload) {
  return {
    summary: {
      total: payload.subscriptions.length,
      creates: payload.subscriptions.length,
      replaces: 0,
      skips: 0,
      errors: 0,
      warnings: 0,
    },
    items: payload.subscriptions.map((subscription, index) => ({
      index,
      name: subscription.name,
      source: "renewlet" as const,
      sourceId: subscription.extra.import.sourceId,
      action: "create" as const,
      warnings: [],
      errors: [],
    })),
    includesSettings: Boolean(payload.settings),
    includesCustomConfig: Boolean(payload.customConfig),
    includesExchangeRateSnapshots: Boolean(payload.exchangeRateSnapshots?.length),
    exchangeRateSnapshotsCount: payload.exchangeRateSnapshots?.length ?? 0,
    includesGroups: Boolean(payload.groups?.length),
    groupsCount: payload.groups?.length ?? 0,
    includesBillingRecords: Boolean(payload.billingRecords?.length),
    billingRecordsCount: payload.billingRecords?.length ?? 0,
  };
}

describe("importExportService.applyChunked", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends groups in the first chunk and settings/billing records only in the last chunk", async () => {
    const requests: ImportPayload[] = [];
    const requestSkipIndexes: number[][] = [];
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { payload: ImportPayload; skipIndexes: number[] };
      requestCount += 1;
      requests.push(body.payload);
      requestSkipIndexes.push(body.skipIndexes);
      return new Response(JSON.stringify({ ok: true, data: applyData(body.payload) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const payload = {
      source: "renewlet",
      subscriptions: Array.from({ length: IMPORT_APPLY_SUBSCRIPTION_LIMIT + 1 }, (_, index) => subscriptionPayload(index)),
      settings: { defaultCurrency: "USD" },
      groups: [{ id: "grp_1", name: "Work", sortOrder: 0 }],
      billingRecords: [billingRecordPayload("sub_200")],
    } as ImportPayload;

    const result = await importExportService.applyChunked(payload, "skip", [200]);

    expect(requests).toHaveLength(2);
    // 第一块：组先于订阅落库；流水/设置不能提前出现。
    expect(requests[0]?.subscriptions).toHaveLength(IMPORT_APPLY_SUBSCRIPTION_LIMIT);
    expect(requests[0]?.groups).toEqual(payload.groups);
    expect(requests[0]).not.toHaveProperty("billingRecords");
    expect(requests[0]).not.toHaveProperty("settings");
    expect(requestSkipIndexes[0]).toEqual([]);
    // 最后一块：全部订阅就绪后才放流水；设置和流水只出现一次。
    expect(requests[1]?.subscriptions).toHaveLength(1);
    expect(requests[1]).not.toHaveProperty("groups");
    expect(requests[1]?.billingRecords).toEqual(payload.billingRecords);
    expect(requests[1]?.settings).toEqual(payload.settings);
    expect(requestSkipIndexes[1]).toEqual([0]);
    // 汇总响应按整包计数，items 下标重排回全局。
    expect(result.summary).toMatchObject({ total: 201, creates: 201 });
    expect(result.items.at(-1)?.index).toBe(200);
    expect(result).toMatchObject({ includesGroups: true, groupsCount: 1, includesBillingRecords: true, billingRecordsCount: 1 });
  });

  it("keeps small payloads in a single request with every section", async () => {
    const requests: ImportPayload[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { payload: ImportPayload };
      requests.push(body.payload);
      return new Response(JSON.stringify({ ok: true, data: applyData(body.payload) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const payload = {
      source: "renewlet",
      subscriptions: [subscriptionPayload(0)],
      groups: [{ id: "grp_1", name: "Work", sortOrder: 0 }],
      billingRecords: [billingRecordPayload("sub_0")],
    } as ImportPayload;

    const result = await importExportService.applyChunked(payload, "skip");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.groups).toHaveLength(1);
    expect(requests[0]?.billingRecords).toHaveLength(1);
    expect(result).toMatchObject({ groupsCount: 1, billingRecordsCount: 1 });
  });
});
