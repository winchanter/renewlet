import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { apiSubscriptionSchema, type ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCloudBackupExportZip } from "./cloud-backup-export";
import type { AssetRow, BillingRecordRow, Env } from "./types";

const dbMocks = vi.hoisted(() => ({
  getAsset: vi.fn(),
  getCustomConfig: vi.fn(),
  getSettings: vi.fn(),
  listSubscriptions: vi.fn(),
  toApiSubscription: vi.fn(),
}));
const snapshotMocks = vi.hoisted(() => ({
  listExchangeRateSnapshots: vi.fn(),
}));
const billingMocks = vi.hoisted(() => ({
  listBillingRecordsForUser: vi.fn(),
}));

vi.mock("./db", () => ({
  getAsset: dbMocks.getAsset,
  getCustomConfig: dbMocks.getCustomConfig,
  getSettings: dbMocks.getSettings,
  listSubscriptions: dbMocks.listSubscriptions,
  toApiSubscription: dbMocks.toApiSubscription,
}));

vi.mock("./exchange-rate-snapshots", () => ({
  listExchangeRateSnapshots: snapshotMocks.listExchangeRateSnapshots,
}));

// toApiBillingRecord 保持真实实现：本套件要验证行→API 形状与凭证 ID 保留行为。
vi.mock("./billing-records", async (importOriginal) => ({
  ...await importOriginal<typeof import("./billing-records")>(),
  listBillingRecordsForUser: billingMocks.listBillingRecordsForUser,
}));

describe("Cloudflare cloud backup export ZIP", () => {
  beforeEach(() => {
    dbMocks.getAsset.mockReset().mockResolvedValue(null);
    dbMocks.getCustomConfig.mockReset().mockResolvedValue({ categories: [], statuses: [], paymentMethods: [], currencies: [] });
    dbMocks.getSettings.mockReset().mockResolvedValue(createDefaultAppSettings());
    dbMocks.listSubscriptions.mockReset().mockResolvedValue([]);
    dbMocks.toApiSubscription.mockReset().mockImplementation((row: ApiSubscription) => row);
    snapshotMocks.listExchangeRateSnapshots.mockReset().mockResolvedValue([]);
    billingMocks.listBillingRecordsForUser.mockReset().mockResolvedValue([]);
  });

  it("removes subscription logos when D1 metadata exists but the R2 object is missing", async () => {
    dbMocks.listSubscriptions.mockResolvedValue([subscriptionFixture({ logo: "/api/app/assets/asset_logo" })]);
    dbMocks.getAsset.mockResolvedValue(assetRow({ id: "asset_logo", r2_key: "missing/logo.svg" }));

    const { content } = await buildCloudBackupExportZip(envWithR2({}), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");
    const manifest = readStoredZipJson(content, "manifest.json");

    expect(data.data.subscriptions[0]).not.toHaveProperty("logo");
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_logo",
      path: "/api/app/assets/asset_logo",
      reference: "subscription.logo",
      referenceId: "sub_1",
      reason: "file_missing",
    }]);
  });

  it("exports payment method icons and audits only missing R2 objects", async () => {
    dbMocks.getCustomConfig.mockResolvedValue({
      categories: [],
      statuses: [],
      paymentMethods: [
        { id: "pm_ok", value: "card", labels: { "zh-CN": "Card", "en-US": "Card" }, icon: "/api/app/assets/asset_icon" },
        { id: "pm_missing", value: "wallet", labels: { "zh-CN": "Wallet", "en-US": "Wallet" }, icon: "/api/app/assets/asset_missing" },
      ],
      currencies: [],
    });
    dbMocks.getAsset.mockImplementation(async (_env: Env, _userId: string, assetId: string) => (
      assetId === "asset_icon"
        ? assetRow({ id: "asset_icon", r2_key: "icons/card.svg" })
        : assetRow({ id: "asset_missing", r2_key: "icons/missing.svg" })
    ));

    const { content } = await buildCloudBackupExportZip(envWithR2({ "icons/card.svg": "<svg />" }), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");
    const manifest = readStoredZipJson(content, "manifest.json");

    expect(data.data.customConfig.paymentMethods[0].icon).toBe("assets/asset_icon.svg");
    expect(data.data.customConfig.paymentMethods[1]).not.toHaveProperty("icon");
    expect(readStoredZipText(content, "assets/asset_icon.svg")).toBe("<svg />");
    expect(manifest.assets).toBe(1);
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_missing",
      path: "/api/app/assets/asset_missing",
      reference: "customConfig.paymentMethods.icon",
      referenceId: "pm_missing",
      reason: "file_missing",
    }]);
  });

  it("includes exchange rate snapshots in the recoverable data payload", async () => {
    snapshotMocks.listExchangeRateSnapshots.mockResolvedValue([{
      schemaVersion: 1,
      month: "2026-08",
      base: "USD",
      rates: { USD: 1, CNY: 7 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    }]);

    const { content } = await buildCloudBackupExportZip(envWithR2({}), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");

    expect(data.data.exchangeRateSnapshots).toEqual([{
      schemaVersion: 1,
      month: "2026-08",
      base: "USD",
      rates: { USD: 1, CNY: 7 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    }]);
  });

  it("loads multiple R2 assets sequentially through the export call chain", async () => {
    dbMocks.getCustomConfig.mockResolvedValue({
      categories: [],
      statuses: [],
      paymentMethods: [
        { id: "pm_one", value: "one", labels: { "zh-CN": "One", "en-US": "One" }, icon: "/api/app/assets/asset_one" },
        { id: "pm_two", value: "two", labels: { "zh-CN": "Two", "en-US": "Two" }, icon: "/api/app/assets/asset_two" },
      ],
      currencies: [],
    });
    dbMocks.getAsset.mockImplementation(async (_env: Env, _userId: string, assetId: string) => (
      assetRow({ id: assetId, r2_key: `${assetId}.svg`, size_bytes: null })
    ));
    const reads: string[] = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    const env = envWithR2({
      "asset_one.svg": "<svg>one</svg>",
      "asset_two.svg": "<svg>two</svg>",
    }, async (key) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await Promise.resolve();
      reads.push(key);
      activeReads -= 1;
    });

    await buildCloudBackupExportZip(env, "usr_cloud");

    expect(reads).toEqual(["asset_one.svg", "asset_two.svg"]);
    expect(maxActiveReads).toBe(1);
  });

  it("exports billing records, keeps only readable receipt assets, and audits missing ones", async () => {
    billingMocks.listBillingRecordsForUser.mockResolvedValue([
      billingRecordRowFixture({
        id: "bill_1",
        subscription_id: "sub_1",
        receipt_asset_ids: JSON.stringify(["asset_receipt_ok", "asset_receipt_missing"]),
      }),
    ]);
    dbMocks.getAsset.mockImplementation(async (_env: Env, _userId: string, assetId: string) => {
      if (assetId === "asset_receipt_ok") {
        return assetRow({
          id: assetId,
          kind: "receipt",
          r2_key: "receipts/ok.png",
          size_bytes: null,
          mime_type: "image/png",
          original_name: "ok.png",
        });
      }
      if (assetId === "asset_receipt_missing") {
        return assetRow({
          id: assetId,
          kind: "receipt",
          r2_key: "receipts/missing.png",
          size_bytes: null,
          mime_type: "image/png",
        });
      }
      return null;
    });

    const { content } = await buildCloudBackupExportZip(envWithR2({ "receipts/ok.png": "PNG-BYTES" }), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");
    const manifest = readStoredZipJson(content, "manifest.json");

    expect(data.data.billingRecords).toHaveLength(1);
    expect(data.data.billingRecords[0].id).toBe("bill_1");
    expect(data.data.billingRecords[0].subscriptionId).toBe("sub_1");
    // Worker 没有分组表：groups 段恒缺席，manifest 计数为 0。
    expect(data.data).not.toHaveProperty("groups");
    expect(data.data.billingRecords[0].receiptAssetIds).toEqual(["asset_receipt_ok"]);
    expect(readStoredZipText(content, "assets/asset_receipt_ok.png")).toBe("PNG-BYTES");
    expect(manifest.groups).toBe(0);
    expect(manifest.billingRecords).toBe(1);
    expect(manifest.assets).toBe(1);
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_receipt_missing",
      path: "/api/app/assets/asset_receipt_missing",
      reference: "billingRecord.receiptAssetIds",
      referenceId: "bill_1",
      reason: "file_missing",
    }]);
  });
});

function envWithR2(objects: Record<string, string>, beforeGet?: (key: string) => Promise<void>): Env {
  const encoder = new TextEncoder();
  return {
    ASSETS_BUCKET: {
      head: vi.fn(async (key: string) => {
        const value = objects[key];
        if (value === undefined) return null;
        return {
          size: encoder.encode(value).byteLength,
          httpMetadata: { contentType: "image/svg+xml" },
        } as R2Object;
      }),
      get: vi.fn(async (key: string) => {
        const value = objects[key];
        if (value === undefined) return null;
        await beforeGet?.(key);
        const bytes = encoder.encode(value);
        return {
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          httpMetadata: { contentType: "image/svg+xml" },
        } as R2ObjectBody;
      }),
    } as unknown as R2Bucket,
  } as Env;
}

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset_logo",
    user_id: "usr_cloud",
    kind: "logo",
    r2_key: "assets/logo.svg",
    original_name: "logo.svg",
    mime_type: "image/svg+xml",
    size_bytes: 7,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

function billingRecordRowFixture(overrides: Partial<BillingRecordRow> = {}): BillingRecordRow {
  return {
    id: "bill_record",
    user_id: "usr_cloud",
    subscription_id: "sub_record",
    name: "Record Plan",
    billing_date: "2026-01-31",
    period_end_date: "2026-02-28",
    amount: "12",
    currency: "USD",
    billing_cycle: "monthly",
    custom_days: null,
    custom_cycle_unit: null,
    one_time_term_count: null,
    one_time_term_unit: null,
    usage_unit: null,
    usage_total: null,
    usage_daily_rate: null,
    usage_remaining_before: 0,
    usage_expires_at: "",
    receipt_asset_ids: "[]",
    mode: "initial",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function subscriptionFixture(overrides: Partial<ApiSubscription> = {}): ApiSubscription {
  return apiSubscriptionSchema.parse({
    id: "sub_1",
    name: "GitHub",
    logo: undefined,
    price: "4",
    currency: "USD",
    billingCycle: "monthly",
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: "2026-05-21",
    nextBillingDate: "2026-06-21",
    autoRenew: false,
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
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  });
}

function readStoredZipJson(content: Uint8Array, name: string) {
  return JSON.parse(readStoredZipText(content, name));
}

function readStoredZipText(content: Uint8Array, name: string): string {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= content.length) {
    const view = new DataView(content.buffer, content.byteOffset + offset, content.byteLength - offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const entryName = decoder.decode(content.slice(nameStart, nameStart + nameLength));
    const data = content.slice(dataStart, dataStart + compressedSize);
    if (entryName === name) return decoder.decode(data);
    offset = dataStart + compressedSize;
  }
  throw new Error(`missing ZIP entry ${name}`);
}
