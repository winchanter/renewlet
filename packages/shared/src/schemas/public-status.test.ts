// 公开状态 schema 测试保护隐私 allowlist 和 showPrices 金额投影，避免公开 API 半暴露账单字段。
import { describe, expect, it } from "vitest";
import {
  publicStatusPageCreateResponseSchema,
  publicStatusResponseSchema,
} from "./public-status";
import { appSettingsSchema } from "./settings";

const success = <T>(data: T) => ({ ok: true, data });

describe("public status schemas", () => {
  it("accepts minimal public status rows without prices", () => {
    expect(publicStatusResponseSchema.parse(success({
      page: {
        title: "Renewo",
        showPrices: false,
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "Netflix",
        logo: "https://example.com/netflix.png",
        category: { value: "streaming", label: "Streaming", color: "#ef4444" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }],
    })).data.subscriptions[0]?.price).toBeUndefined();
    expect(publicStatusResponseSchema.safeParse({
      page: { title: "Renewo", showPrices: false, generatedAt: "2026-06-07T00:00:00.000Z", truncated: false },
      subscriptions: [],
    }).success).toBe(false);
  });

  it("accepts public status rows with unknown recurring start dates", () => {
    expect(publicStatusResponseSchema.parse(success({
      page: {
        title: "Renewo",
        showPrices: false,
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "QQ Music",
        category: { value: "streaming", label: "Streaming" },
        status: "active",
        startDate: null,
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
      }],
    })).data.subscriptions[0]?.startDate).toBeNull();
  });

  it("requires price and currency to be exposed together", () => {
    // showPrices 是公开账单字段唯一开关；schema 让金额、币种和周期同进同出，避免半公开账单信息。
    expect(publicStatusResponseSchema.safeParse(success({
      page: {
        title: "Renewo",
        showPrices: true,
        currency: "USD",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "Netflix",
        category: { value: "streaming", label: "Streaming" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
        price: "9.99",
      }],
    })).success).toBe(false);
  });

  it("requires public page currency and billing cycle only when prices are visible", () => {
    expect(publicStatusResponseSchema.safeParse(success({
      page: {
        title: "Renewo",
        showPrices: true,
        currency: "USD",
        exchangeRateBasis: {
          status: "locked",
          month: "2026-06",
          base: "USD",
          rates: { USD: 1, CNY: 7.1 },
          sourceDate: "2026-06-06",
          capturedAt: "2026-06-07T00:00:00.000Z",
        },
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "Annual Plan",
        category: { value: "streaming", label: "Streaming" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
        price: "120",
        currency: "USD",
        billingCycle: "annual",
      }],
    })).success).toBe(true);

    expect(publicStatusResponseSchema.safeParse(success({
      page: {
        title: "Renewo",
        showPrices: false,
        currency: "USD",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [],
    })).success).toBe(false);

    expect(publicStatusResponseSchema.safeParse(success({
      page: {
        title: "Renewo",
        showPrices: false,
        exchangeRateBasis: { status: "live", month: "2026-06" },
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [],
    })).success).toBe(false);
  });

  it("rejects incomplete or unrelated cycle-specific fields", () => {
    const publicResponse = (subscription: Record<string, unknown>) => success({
      page: {
        title: "Renewo",
        showPrices: true,
        currency: "USD",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "Custom Plan",
        category: { value: "streaming", label: "Streaming" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-07-01",
        updatedAt: "2026-06-07T00:00:00.000Z",
        price: "12",
        currency: "USD",
        ...subscription,
      }],
    });

    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "custom",
      customDays: 3,
    })).success).toBe(false);
    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "monthly",
      customDays: 3,
      customCycleUnit: "month",
    })).success).toBe(false);
    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "month",
    })).success).toBe(true);
  });

  it("projects usage-based quantities only together with prices and billing cycle", () => {
    const publicResponse = (subscription: Record<string, unknown>) => success({
      page: {
        title: "Renewo",
        showPrices: true,
        currency: "USD",
        generatedAt: "2026-06-07T00:00:00.000Z",
        truncated: false,
      },
      subscriptions: [{
        name: "SMS Pack",
        category: { value: "communication", label: "Communication" },
        status: "active",
        startDate: "2026-01-01",
        nextBillingDate: "2026-04-11",
        updatedAt: "2026-06-07T00:00:00.000Z",
        price: "50",
        currency: "USD",
        ...subscription,
      }],
    });

    // usage-based 公开投影只输出月均摊销所需字段；总量与日均必须随价格同进同出。
    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "usage-based",
      usageTotal: 1000,
      usageDailyRate: 10,
    })).success).toBe(true);
    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "usage-based",
      usageTotal: 1000,
    })).success).toBe(false);
    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "usage-based",
    })).success).toBe(false);
    expect(publicStatusResponseSchema.safeParse(publicResponse({
      billingCycle: "monthly",
      usageTotal: 1000,
      usageDailyRate: 10,
    })).success).toBe(false);
  });

  it("accepts inherited or explicit public status currency settings", () => {
    expect(appSettingsSchema.pick({ publicStatusCurrency: true }).parse({ publicStatusCurrency: "inherit" }).publicStatusCurrency).toBe("inherit");
    expect(appSettingsSchema.pick({ publicStatusCurrency: true }).parse({ publicStatusCurrency: "USD" }).publicStatusCurrency).toBe("USD");
    expect(appSettingsSchema.pick({ publicStatusCurrency: true }).safeParse({ publicStatusCurrency: "usd" }).success).toBe(false);
  });

  it("keeps management create responses on bearer URL shape", () => {
    expect(publicStatusPageCreateResponseSchema.safeParse(success({
      publicStatusPage: {
        enabled: true,
        createdAt: "2026-06-07T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
        pageUrl: "https://renewlet.example/status/abc123abc123abc123abc123abc123abc123abc123a",
        showPrices: false,
      },
    })).success).toBe(true);
  });
});
