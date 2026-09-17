// Renewo 导入测试保护正式导出格式，旧导入桥删除后不能再放宽自导入契约。
import { describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS, type Subscription } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import { renewletExportV1Schema } from "@/lib/api/schemas/import-export";
import { parseJsonText } from "./wallos-import";
import { IMPORT_MESSAGE_CODES, subscriptionToExportRow } from "./import-export-model";
import { buildFromRenewletExport } from "./wallos-import-mapping";

const context = {
  config: DEFAULT_CUSTOM_CONFIG,
  settings: DEFAULT_SETTINGS,
  today: assertDateOnly("2026-05-21"),
};

const currentExportSubscription = {
  id: "current-1",
  name: "Current Backup",
  logo: undefined,
  price: "42",
  currency: "USD",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  category: "developer_tools",
  status: "active",
  pinned: true,
  publicHidden: false,
  paymentMethod: undefined,
  startDate: assertDateOnly("2026-05-01"),
  nextBillingDate: assertDateOnly("2026-06-01"),
  autoRenew: true,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: undefined,
  notes: undefined,
  tags: [],
  reminderDays: 3,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
} satisfies Subscription;

describe("renewlet import", () => {
  it("rejects legacy Renewo bare subscription arrays", async () => {
    await expect(parseJsonText(JSON.stringify([
      {
        id: "03v2x7u3pyafogh",
        name: "Docker",
        price: "10",
        currency: "USD",
        category: "productivity",
        status: "active",
        startDate: "2026-04-16",
        nextBillingDate: "2026-06-16",
        autoCalculateNextBillingDate: true,
        trialEndDate: null,
        tags: [],
        reminderDays: 3,
        repeatReminderEnabled: false,
        repeatReminderInterval: "1h",
        repeatReminderWindow: "72h",
        billingCycle: "monthly",
      },
    ]), context)).rejects.toThrow(IMPORT_MESSAGE_CODES.unrecognizedFile);
  });

  it("rejects legacy Renewo object wrappers", async () => {
    await expect(parseJsonText(JSON.stringify({
      data: {
        subscriptions: [{
          id: "legacy-1",
          name: "Legacy Netflix",
          price: "15.99",
          currency: "USD",
          billingCycle: "monthly",
          category: "streaming",
          status: "active",
          startDate: "2026-01-01",
          nextBillingDate: "2026-06-01",
        }],
      },
    }), context)).rejects.toThrow(IMPORT_MESSAGE_CODES.unrecognizedFile);
  });

  it("builds current Renewo v1 export rows that satisfy schema and keep pinned", () => {
    const row = subscriptionToExportRow(currentExportSubscription);

    const parsed = renewletExportV1Schema.parse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [row],
        settings: { defaultCurrency: "USD" },
        customConfig: DEFAULT_CUSTOM_CONFIG,
        assets: [],
      },
    });

    expect(row.pinned).toBe(true);
    expect(parsed.data.subscriptions[0]?.pinned).toBe(true);
  });

  it("keeps current Renewo v1 exports on the schema-backed path", async () => {
    const prepared = await parseJsonText(JSON.stringify({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [currentExportSubscription],
        settings: { defaultCurrency: "USD" },
        customConfig: DEFAULT_CUSTOM_CONFIG,
        assets: [],
      },
    }), context);

    expect(prepared.payload.source).toBe("renewlet");
    expect(prepared.payload.subscriptions[0]?.extra.import).toEqual({
      source: "renewlet",
      sourceId: "current-1",
      confidence: "high",
    });
    expect(prepared.payload.subscriptions[0]?.pinned).toBe(true);
    expect(prepared.payload.settings?.defaultCurrency).toBe("USD");
    expect(prepared.payload.customConfig?.statuses.some((item) => item.value === "expired")).toBe(true);
    expect(prepared.warnings).toHaveLength(0);
  });

  it("stages payment method icons from Renewo ZIP assets and removes missing ZIP icon paths", () => {
    const parsed = renewletExportV1Schema.parse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [currentExportSubscription],
        settings: { defaultCurrency: "USD" },
        customConfig: {
          ...DEFAULT_CUSTOM_CONFIG,
          paymentMethods: [
            { id: "pm_card", value: "card", labels: { "zh-CN": "Card", "en-US": "Card" }, icon: "assets/asset_icon.svg" },
            { id: "pm_missing", value: "wallet", labels: { "zh-CN": "Wallet", "en-US": "Wallet" }, icon: "assets/missing.svg" },
          ],
        },
        assets: [{ id: "asset_icon", path: "assets/asset_icon.svg", mimeType: "image/svg+xml", sizeBytes: 7 }],
      },
    });

    const assetBuffer = new TextEncoder().encode("<svg />").buffer;
    const prepared = buildFromRenewletExport(parsed, context, new Map([[
      "assets/asset_icon.svg",
      { buffer: assetBuffer, mimeType: "image/svg+xml" },
    ]]));

    expect(prepared.assets).toEqual([{
      target: { type: "paymentMethodIcon", paymentMethodIndex: 0 },
      kind: "icon",
      filename: "asset_icon.svg",
      buffer: assetBuffer,
      mimeType: "image/svg+xml",
    }]);
    expect(prepared.payload.customConfig?.paymentMethods[0]).not.toHaveProperty("icon");
    expect(prepared.payload.customConfig?.paymentMethods[1]).not.toHaveProperty("icon");
  });

  it("stages group logos and billing receipts, remaps group ids, and drops receipts missing from ZIP", () => {
    const parsed = renewletExportV1Schema.parse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [{ ...currentExportSubscription, groupId: "grp_1" }],
        groups: [
          { id: "grp_1", name: "Work", logo: "assets/asset_grp.svg", sortOrder: 0 },
          { id: "grp_2", name: "Home", logo: null, sortOrder: 1 },
        ],
        billingRecords: [
          {
            id: "bill_1",
            subscriptionId: "current-1",
            name: "Current Backup",
            billingDate: "2026-05-01",
            periodEndDate: "2026-06-01",
            amount: "42.00",
            currency: "USD",
            mode: "initial",
            receiptAssetIds: ["asset_rcpt", "asset_missing"],
            billingCycle: "monthly",
            usageRemainingBefore: null,
            usageExpiresAt: null,
          },
          // "asset_rc" 不能因前缀碰撞命中 ZIP 里的 asset_rcpt.png：stem 必须精确相等。
          {
            id: "bill_2",
            subscriptionId: "current-1",
            name: "Current Backup",
            billingDate: "2026-04-01",
            periodEndDate: "2026-05-01",
            amount: "42.00",
            currency: "USD",
            mode: "auto",
            receiptAssetIds: ["asset_rc"],
            billingCycle: "monthly",
            usageRemainingBefore: null,
            usageExpiresAt: null,
          },
        ],
        assets: [
          { id: "asset_grp", path: "assets/asset_grp.svg", mimeType: "image/svg+xml", sizeBytes: 7 },
          { id: "asset_rcpt", path: "assets/asset_rcpt.png", mimeType: "image/png", sizeBytes: 9 },
        ],
      },
    });
    const grpBuffer = new TextEncoder().encode("<svg />").buffer;
    const rcptBuffer = new TextEncoder().encode("PNG-BYTES").buffer;
    const prepared = buildFromRenewletExport(parsed, context, new Map([
      ["assets/asset_grp.svg", { buffer: grpBuffer, mimeType: "image/svg+xml" }],
      ["assets/asset_rcpt.png", { buffer: rcptBuffer, mimeType: "image/png" }],
    ]));

    // 订阅透传源分组 ID，服务端建组后重映射。
    expect(prepared.payload.subscriptions[0]?.groupId).toBe("grp_1");
    expect(prepared.payload.groups).toEqual([
      { id: "grp_1", name: "Work", logo: null, sortOrder: 0 },
      { id: "grp_2", name: "Home", logo: null, sortOrder: 1 },
    ]);
    expect(prepared.payload.billingRecords?.[0]?.receiptAssetIds).toEqual(["asset_rcpt"]);
    expect(prepared.payload.billingRecords?.[1]?.receiptAssetIds).toEqual([]);
    expect(prepared.assets).toEqual([
      { target: { type: "groupLogo", groupIndex: 0 }, kind: "logo", filename: "asset_grp.svg", buffer: grpBuffer, mimeType: "image/svg+xml" },
      { target: { type: "billingReceipt", billingRecordIndex: 0, assetId: "asset_rcpt" }, kind: "receipt", filename: "asset_rcpt.png", buffer: rcptBuffer, mimeType: "image/png" },
    ]);
  });

  it("preserves cycle-specific fields for custom, one-time fixed-term and usage-based subscriptions", () => {
    const base = {
      name: "Cycle",
      logo: undefined,
      price: "10",
      currency: "USD",
      category: "developer_tools",
      status: "active",
      pinned: false,
      publicHidden: false,
      paymentMethod: undefined,
      startDate: assertDateOnly("2026-05-01"),
      nextBillingDate: assertDateOnly("2026-06-01"),
      autoCalculateNextBillingDate: true,
      trialEndDate: undefined,
      website: undefined,
      notes: undefined,
      tags: [],
      reminderDays: 3,
      repeatReminderEnabled: false,
      repeatReminderInterval: "1h",
      repeatReminderWindow: "72h",
      extra: {},
    } as const;
    const parsed = renewletExportV1Schema.parse({
      kind: "renewlet-export",
      schemaVersion: 1,
      exportedAt: "2026-05-26T00:00:00.000Z",
      data: {
        subscriptions: [
          { ...base, id: "sub_custom", billingCycle: "custom", customDays: 30, customCycleUnit: "day", autoRenew: true },
          {
            ...base,
            id: "sub_fixed",
            billingCycle: "one-time",
            oneTimeTermCount: 12,
            oneTimeTermUnit: "month",
            autoRenew: false,
            autoCalculateNextBillingDate: false,
          },
          {
            ...base,
            id: "sub_usage",
            billingCycle: "usage-based",
            usageUnit: "GB",
            usageTotal: 500,
            usageDailyRate: 10,
            usageExpiresAt: "2026-08-31",
            autoRenew: false,
          },
        ],
        assets: [],
      },
    });

    // buildFromRenewletExport 内部执行 importPayloadSchema.parse：
    // 修复前 usage-based 行因三个 usage 字段被映射丢弃而在这里抛 refine 错误。
    const prepared = buildFromRenewletExport(parsed, context);

    expect(prepared.payload.subscriptions).toEqual([
      expect.objectContaining({ billingCycle: "custom", customDays: 30, customCycleUnit: "day" }),
      expect.objectContaining({
        billingCycle: "one-time",
        oneTimeTermCount: 12,
        oneTimeTermUnit: "month",
        usageUnit: null,
        usageTotal: null,
      }),
      expect.objectContaining({
        billingCycle: "usage-based",
        usageUnit: "GB",
        usageTotal: 500,
        usageDailyRate: 10,
        usageExpiresAt: "2026-08-31",
        customDays: null,
        customCycleUnit: null,
      }),
    ]);
  });
});
