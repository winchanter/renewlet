import { beforeEach, describe, expect, it, vi } from "vitest";
import { renewletExportManifestV1Schema, renewletExportV1Schema } from "@/lib/api/schemas/import-export";
import { assertDateOnly } from "@/lib/time/date-only";
import type { RunWorkerJobOptions } from "@/lib/workers/run-worker-job";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { DEFAULT_SETTINGS, type RecurringCycleSubscription } from "@/types/subscription";
import { exportRenewletBackup } from "./renewlet-export";
import type { ApiBillingRecord } from "@/lib/api/schemas/billing-records";
import type { SubscriptionGroup } from "@renewlet/shared/schemas/subscription-groups";
import type {
  RenewletExportWorkerPayload,
  RenewletExportWorkerResult,
} from "./renewlet-export-worker-contract";

type RunExportWorkerMock = (
  options: RunWorkerJobOptions<RenewletExportWorkerPayload>,
) => Promise<RenewletExportWorkerResult>;

const exportMocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  runWorkerJob: vi.fn<RunExportWorkerMock>(),
}));

vi.mock("@/shared/browser/download-file", () => ({
  downloadFile: exportMocks.downloadFile,
}));

vi.mock("@/lib/workers/run-worker-job", () => ({
  runWorkerJob: exportMocks.runWorkerJob,
}));

describe("exportRenewletBackup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    exportMocks.downloadFile.mockReset();
    exportMocks.runWorkerJob.mockReset().mockResolvedValue({ buffer: new Uint8Array([80, 75]).buffer });
  });

  it("removes missing private subscription logos from data.json and audits them in manifest.json", async () => {
    const fetchPrivateAsset = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));

    await exportRenewletBackup({
      subscriptions: [subscriptionFixture({ id: "sub_1", logo: "/api/app/assets/asset_missing" })],
      settings: DEFAULT_SETTINGS,
      customConfig: DEFAULT_CUSTOM_CONFIG,
      includeSecrets: false,
    });
    const { data, manifest } = readWorkerEntries();

    expect(data.data.subscriptions[0]).not.toHaveProperty("logo");
    expect(fetchPrivateAsset).toHaveBeenCalledWith("/api/app/assets/asset_missing", { credentials: "include" });
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_missing",
      path: "/api/app/assets/asset_missing",
      reference: "subscription.logo",
      referenceId: "sub_1",
      reason: "not_found",
    }]);
  });

  it("transfers custom payment method icons to the ZIP worker and rewrites data.json", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<svg />", {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    }));
    const customConfig: CustomConfig = {
      ...DEFAULT_CUSTOM_CONFIG,
      paymentMethods: [{
        id: "pm_card",
        value: "card",
        labels: { "zh-CN": "Card", "en-US": "Card" },
        icon: "/api/app/assets/asset_icon",
      }],
    };

    await exportRenewletBackup({
      subscriptions: [subscriptionFixture()],
      settings: DEFAULT_SETTINGS,
      customConfig,
      includeSecrets: false,
    });
    const { data, entries, manifest, transfer } = readWorkerEntries();

    expect(data.data.customConfig?.paymentMethods[0]?.icon).toBe("assets/asset_icon.svg");
    const asset = entries.get("assets/asset_icon.svg");
    if (!(asset instanceof ArrayBuffer)) throw new Error("expected transferable asset buffer");
    expect(new TextDecoder().decode(asset)).toBe("<svg />");
    expect(data.data.assets).toEqual([{ id: "asset_icon", path: "assets/asset_icon.svg", mimeType: "image/svg+xml", sizeBytes: 7 }]);
    expect(manifest.missingAssets).toEqual([]);
    expect(transfer).toContain(asset);
  });

  it("writes exchange rate snapshots into the recoverable data payload", async () => {
    await exportRenewletBackup({
      subscriptions: [subscriptionFixture()],
      settings: DEFAULT_SETTINGS,
      customConfig: DEFAULT_CUSTOM_CONFIG,
      includeSecrets: false,
      exchangeRateSnapshots: [{
        schemaVersion: 1,
        month: "2026-08",
        base: "USD",
        rates: { USD: 1, CNY: 7 },
        requestedProvider: "frankfurter",
        provider: "frankfurter",
        sourceDate: "2026-08-01",
        capturedAt: "2026-08-06T00:00:00.000Z",
      }],
    });
    const { data } = readWorkerEntries();

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
    expect(exportMocks.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ type: "application/zip" }),
      expect.stringMatching(/^renewlet-export-v1-\d{4}-\d{2}-\d{2}\.zip$/),
    );
  });

  it("exports groups with logos and billing records with readable receipts, auditing missing receipts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/app/assets/asset_grp_logo") {
        return new Response("<svg />", { status: 200, headers: { "content-type": "image/svg+xml" } });
      }
      if (url === "/api/app/assets/asset_rcpt_ok") {
        return new Response("PNG-BYTES", { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response("", { status: 404 });
    });
    const group = {
      id: "grp_1",
      name: "Work",
      logo: "/api/app/assets/asset_grp_logo",
      description: null,
      sortOrder: 2,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    } satisfies SubscriptionGroup;
    const billingRecord = {
      id: "bill_1",
      subscriptionId: "sub_1",
      name: "GitHub",
      billingDate: "2026-05-21",
      periodEndDate: "2026-06-21",
      amount: "4.00",
      currency: "USD",
      mode: "auto",
      receiptAssetIds: ["asset_rcpt_ok", "asset_rcpt_missing"],
      billingCycle: "monthly",
      usageRemainingBefore: null,
      usageExpiresAt: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
    } as ApiBillingRecord;

    await exportRenewletBackup({
      subscriptions: [subscriptionFixture()],
      settings: DEFAULT_SETTINGS,
      customConfig: DEFAULT_CUSTOM_CONFIG,
      includeSecrets: false,
      groups: [group],
      billingRecords: [billingRecord],
    });
    const { data, entries, manifest } = readWorkerEntries();

    expect(data.data.groups).toEqual([{
      id: "grp_1",
      name: "Work",
      logo: "assets/asset_grp_logo.svg",
      sortOrder: 2,
    }]);
    expect(data.data.billingRecords).toHaveLength(1);
    // 凭证在 data.json 保留源资产 ID（恢复上传后重写）；读不到的 ID 移除。
    expect(data.data.billingRecords[0]?.receiptAssetIds).toEqual(["asset_rcpt_ok"]);
    expect(entries.has("assets/asset_grp_logo.svg")).toBe(true);
    expect(entries.has("assets/asset_rcpt_ok.png")).toBe(true);
    expect(manifest).toMatchObject({ groups: 1, billingRecords: 1, assets: 2 });
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_rcpt_missing",
      path: "/api/app/assets/asset_rcpt_missing",
      reference: "billingRecord.receiptAssetIds",
      referenceId: "bill_1",
      reason: "not_found",
    }]);
  });
});

function readWorkerEntries() {
  const options = exportMocks.runWorkerJob.mock.calls[0]?.[0];
  if (!options) throw new Error("expected ZIP worker job");
  const entries = new Map(options.payload.entries.map((entry) => [entry.name, entry.data]));
  const dataJson = entries.get("data.json");
  const manifestJson = entries.get("manifest.json");
  if (typeof dataJson !== "string" || typeof manifestJson !== "string") {
    throw new Error("expected string data and manifest entries");
  }
  return {
    entries,
    transfer: options.transfer,
    data: renewletExportV1Schema.parse(JSON.parse(dataJson)),
    manifest: renewletExportManifestV1Schema.parse(JSON.parse(manifestJson)),
  };
}

function subscriptionFixture(overrides: Partial<RecurringCycleSubscription> = {}): RecurringCycleSubscription {
  return {
    id: "sub_1",
    name: "GitHub",
    logo: undefined,
    price: "4",
    currency: "USD",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-05-21"),
    nextBillingDate: assertDateOnly("2026-06-21"),
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
    ...overrides,
  };
}
