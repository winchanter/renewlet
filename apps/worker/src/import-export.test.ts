// Worker 导入测试保护 preview/apply 写入契约，避免 Cloudflare D1 到写库阶段才发现订阅字段错误。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { applyImport, previewImport } from "./import-export";
import { HttpError } from "./http";
import type { Env, SubscriptionRow } from "./types";
import {
  IMPORT_APPLY_SUBSCRIPTION_LIMIT,
  IMPORT_PREVIEW_MAX_BYTES,
  IMPORT_PREVIEW_SUBSCRIPTION_LIMIT,
} from "@renewlet/shared/schemas/import-export";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";

const authUser = {
  id: "usr_import",
  email: "import@example.com",
  name: "Importer",
  role: "admin" as const,
  banned: 0,
  ban_reason: "",
  password_hash: "hash",
  reset_token_hash: null,
  reset_token_expires_at: null,
  created_at: "2026-06-05T00:00:00.000Z",
  updated_at: "2026-06-05T00:00:00.000Z",
};

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  listSubscriptions: vi.fn(),
  getSettings: vi.fn(),
  nowIso: vi.fn(),
  newId: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    listSubscriptions: dbMocks.listSubscriptions,
    getSettings: dbMocks.getSettings,
    nowIso: dbMocks.nowIso,
    newId: dbMocks.newId,
  };
});

function envFixture() {
  // apply 用例通过捕获 bind 顺序验证 D1 写入形状；preview 失败时 batch 必须完全不被触发。
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => {
        statements.push({ sql, values });
        const statement = {
          run: vi.fn(async () => d1Result([], 1)),
          first: vi.fn(async <T>() => {
            if (sql.includes("SUM(CASE WHEN auto_renew")) {
              return { auto_renew_count: 0, repeat_reminder_count: 0 } as T;
            }
            return null;
          }),
          all: vi.fn(async <T>() => d1Result<T>([])),
        };
        return statement;
      },
    })),
    batch: vi.fn(async (batchStatements: D1PreparedStatement[]) => batchStatements.map(() => d1Result([], 1))),
  };
  return {
    env: { DB: db as unknown as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket } as Env,
    db,
    statements,
  };
}

function d1Result<T = unknown>(results: T[] = [], changes = 0): D1Result<T> {
  return { success: true, results, meta: { changes } } as D1Result<T>;
}

function insertedSubscriptionRow(statements: Array<{ sql: string; values: unknown[] }>, index = 0): unknown[] {
  const insert = statements.find((statement) => statement.sql.includes("INSERT INTO subscriptions"));
  if (!insert || typeof insert.values[0] !== "string") throw new Error("Missing bulk subscription insert");
  const rows = JSON.parse(insert.values[0]) as unknown[][];
  const row = rows[index];
  if (!row) throw new Error(`Missing bulk subscription row ${index}`);
  return row;
}

function requestFor(path: string, body: unknown): Request {
  return new Request(`https://renewlet.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test",
      "x-renewlet-locale": "en-US",
    },
    body: JSON.stringify(body),
  });
}

function importSubscription(overrides: Record<string, unknown> = {}) {
  return {
    name: "Imported",
    logo: null,
    price: "12",
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
    extra: { import: { source: "wallos", sourceId: "usr:sub", confidence: "high" } },
    ...overrides,
  };
}

function importPayload(subscriptions: unknown[]) {
  return {
    payload: {
      source: "wallos",
      subscriptions,
    },
    conflictMode: "skip",
    skipIndexes: [],
  };
}

function importBillingRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "bill_src",
    subscriptionId: "sub_src",
    name: "Record Plan",
    billingDate: "2026-05-21",
    periodEndDate: "2026-06-21",
    amount: "12",
    currency: "USD",
    mode: "initial",
    receiptAssetIds: ["asset_receipt_1"],
    billingCycle: "monthly",
    usageRemainingBefore: null,
    usageExpiresAt: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

function renewletRestorePayload(partial: { subscriptions?: unknown[]; groups?: unknown[]; billingRecords?: unknown[] }) {
  return {
    payload: {
      source: "renewlet",
      subscriptions: partial.subscriptions ?? [],
      ...(partial.groups ? { groups: partial.groups } : {}),
      ...(partial.billingRecords ? { billingRecords: partial.billingRecords } : {}),
    },
    conflictMode: "skip",
    skipIndexes: [],
  };
}

function exchangeRateSnapshotPayload(source: "renewlet" | "wallos") {
  return {
    payload: {
      source,
      subscriptions: [],
      exchangeRateSnapshots: [{
        schemaVersion: 1,
        month: "2000-01",
        base: "USD",
        rates: { USD: 1, CNY: 7 },
        requestedProvider: "floatrates",
        provider: "floatrates",
        sourceDate: "2000-01-31",
        capturedAt: "2000-02-01T00:00:00.000Z",
      }],
    },
    conflictMode: "skip",
    skipIndexes: [],
  };
}

describe("Cloudflare import", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    dbMocks.listSubscriptions.mockReset();
    dbMocks.getSettings.mockReset();
    dbMocks.nowIso.mockReset();
    dbMocks.newId.mockReset();
    authMocks.requireAuth.mockResolvedValue({ user: authUser, session: { id: "ses" } });
    dbMocks.listSubscriptions.mockResolvedValue([]);
    dbMocks.getSettings.mockResolvedValue(createDefaultAppSettings());
    dbMocks.nowIso.mockReturnValue("2026-06-05T00:00:00.000Z");
    dbMocks.newId.mockReturnValue("sub_new");
  });

  it("rejects invalid subscription date order during preview before D1 writes", async () => {
    const { env } = envFixture();
    await expect(previewImport(requestFor("/api/app/import/preview", importPayload([
      importSubscription({ startDate: "2026-07-01", nextBillingDate: "2026-06-01" }),
    ])), env)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PAYLOAD",
    } satisfies Partial<HttpError>);
  });

  it("does not write D1 when apply payload fails subscription schema validation", async () => {
    const { env, db } = envFixture();

    await expect(applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({ startDate: "2026-07-01", nextBillingDate: "2026-06-01" }),
    ])), env)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PAYLOAD",
    } satisfies Partial<HttpError>);

    expect(db.batch).not.toHaveBeenCalled();
  });

  it.each([
    ["preview", IMPORT_PREVIEW_SUBSCRIPTION_LIMIT + 1],
    ["apply", IMPORT_APPLY_SUBSCRIPTION_LIMIT + 1],
  ] as const)("rejects %s subscription counts with IMPORT_TOO_LARGE before D1 writes", async (operation, count) => {
    const { env, db } = envFixture();
    const subscriptions = Array.from({ length: count }, (_, index) => importSubscription({
      extra: { import: { source: "wallos", sourceId: `usr:${index}`, confidence: "high" } },
    }));
    const request = requestFor(`/api/app/import/${operation}`, importPayload(subscriptions));
    const execute = operation === "preview" ? previewImport : applyImport;

    await expect(execute(request, env)).rejects.toMatchObject({
      status: 413,
      code: "IMPORT_TOO_LARGE",
    } satisfies Partial<HttpError>);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects request bodies over 8 MiB before D1 writes", async () => {
    const { env, db } = envFixture();
    const request = new Request("https://renewlet.test/api/app/import/preview", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test",
        "x-renewlet-locale": "en-US",
      },
      body: `{"padding":"${"x".repeat(IMPORT_PREVIEW_MAX_BYTES)}"}`,
    });

    await expect(previewImport(request, env)).rejects.toMatchObject({
      status: 413,
      code: "IMPORT_TOO_LARGE",
    } satisfies Partial<HttpError>);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("applies manual recurring imports with nullable start dates", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({
        startDate: null,
        nextBillingDate: "2026-06-21",
        autoCalculateNextBillingDate: false,
      }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const row = insertedSubscriptionRow(statements);
    expect(row[20]).toBeNull();
    expect(row[21]).toBe("2026-06-21");
    expect(row[23]).toBe(0);
  });

  it("normalizes one-time imports before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({
        billingCycle: "one-time",
        customDays: 30,
        customCycleUnit: "day",
        autoCalculateNextBillingDate: true,
      }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const row = insertedSubscriptionRow(statements);
    expect(row[6]).toBe("one-time");
    expect(row[7]).toBeNull();
    expect(row[8]).toBeNull();
    expect(row[9]).toBeNull();
    expect(row[10]).toBeNull();
    expect(row[22]).toBe(0);
    expect(row[23]).toBe(0);
  });

  it("restores historical exchange rate snapshots only from Renewlet ZIP payloads", async () => {
    const { env, db, statements } = envFixture();

    const response = await applyImport(requestFor("/api/app/import/apply", exchangeRateSnapshotPayload("renewlet")), env);
    const data = await readSuccessData<{ includesExchangeRateSnapshots: boolean; exchangeRateSnapshotsCount: number }>(response);

    expect(response.status).toBe(200);
    expect(data).toMatchObject({ includesExchangeRateSnapshots: true, exchangeRateSnapshotsCount: 1 });
    expect(db.batch).toHaveBeenCalledTimes(1);
    const snapshot = statements.find((statement) => statement.sql.includes("INSERT INTO exchange_rate_snapshots"));
    expect(snapshot?.values.slice(0, 8)).toEqual([
      authUser.id,
      "2000-01",
      "USD",
      JSON.stringify({ USD: 1, CNY: 7 }),
      "floatrates",
      "floatrates",
      "2000-01-31",
      "2000-02-01T00:00:00.000Z",
    ]);

    await expect(previewImport(requestFor("/api/app/import/preview", exchangeRateSnapshotPayload("wallos")), env))
      .rejects
      .toMatchObject({ status: 400, code: "IMPORT_EXCHANGE_RATE_SNAPSHOTS_SOURCE_INVALID" });
  });

  it("preserves one-time fixed term fields before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({
        billingCycle: "one-time",
        customDays: 30,
        customCycleUnit: "day",
        oneTimeTermCount: 6,
        oneTimeTermUnit: "month",
        autoCalculateNextBillingDate: true,
      }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const row = insertedSubscriptionRow(statements);
    expect(row[6]).toBe("one-time");
    expect(row[7]).toBeNull();
    expect(row[8]).toBeNull();
    expect(row[9]).toBe(6);
    expect(row[10]).toBe("month");
    expect(row[22]).toBe(0);
    expect(row[23]).toBe(0);
  });

  it("preserves disabled reminder days before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({
        reminderDays: -2,
      }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(insertedSubscriptionRow(statements)[28]).toBe(-2);
  });

  it("preserves cost sharing before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const costSharing = {
      enabled: true,
      splitMode: "custom",
      collectionReminder: { enabled: true, reminderDays: -1 },
      members: [
        { id: "partner", name: "Partner", customAmount: "7", joinedDate: "2026-05-21" },
        { id: "child", name: "Child", customAmount: "5", joinedDate: "2026-05-21" },
      ],
    };
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({ costSharing }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const row = insertedSubscriptionRow(statements);
    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO subscriptions"));
    expect(insert?.sql).toContain("cost_sharing_json");
    expect(JSON.parse(row[32] as string)).toEqual(costSharing);
    expect(row[33]).toBe(1);
    expect(row[34] as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("updates scheduler counts incrementally after applying subscription imports", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({ autoRenew: true, repeatReminderEnabled: true }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const schedulerMutation = statements.find((statement) => statement.sql.includes("UPDATE subscription_scheduler_state SET"));
    expect(schedulerMutation?.values.slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    expect(schedulerMutation?.values.at(-1)).toBe(authUser.id);
  });

  it("keeps a 200-item apply inside one fixed-size D1 transaction", async () => {
    let sequence = 0;
    dbMocks.newId.mockImplementation(() => `sub_bulk_${sequence += 1}`);
    const { env, db } = envFixture();
    const subscriptions = Array.from({ length: IMPORT_APPLY_SUBSCRIPTION_LIMIT }, (_, index) => importSubscription({
      name: `Imported ${index}`,
      extra: { import: { source: "wallos", sourceId: `usr:bulk:${index}`, confidence: "high" } },
    }));

    const response = await applyImport(requestFor("/api/app/import/apply", importPayload(subscriptions)), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const batch = db.batch.mock.calls[0]?.[0] as D1PreparedStatement[] | undefined;
    expect(batch).toHaveLength(9);
  });

  it("defaults missing import autoRenew to manual renewal before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const subscription = { ...importSubscription() } as Record<string, unknown>;
    delete subscription["autoRenew"];
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([subscription])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(insertedSubscriptionRow(statements)[22]).toBe(0);
  });

  it("skips existing import keys unless replace is selected", async () => {
    dbMocks.listSubscriptions.mockResolvedValue([
      {
        id: "sub_existing",
        user_id: "usr_import",
        name: "Imported",
        logo: null,
        price: "12",
        currency: "USD",
        billing_cycle: "monthly",
        custom_days: null,
        custom_cycle_unit: null,
        one_time_term_count: null,
        one_time_term_unit: null,
        usage_unit: null,
        usage_total: null,
        usage_daily_rate: null,
        usage_expires_at: null,
        category: "productivity",
        status: "active",
        pinned: 0,
        public_hidden: 0,
        payment_method: null,
        start_date: "2026-05-21",
        next_billing_date: "2026-06-21",
        auto_renew: 1,
        auto_calculate_next_billing_date: 1,
        trial_end_date: null,
        website: null,
        notes: null,
        tags_json: "[]",
        reminder_days: 3,
        repeat_reminder_enabled: 0,
        repeat_reminder_interval: "1h",
        repeat_reminder_window: "72h",
        cost_sharing_json: "{}",
        cost_sharing_collection_reminder_enabled: 0,
        cost_sharing_next_collection_reminder_date: null,
        extra_json: JSON.stringify({ import: { source: "wallos", sourceId: "usr:sub", confidence: "high" } }),
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      } satisfies SubscriptionRow,
    ]);
    const { env } = envFixture();

    const response = await previewImport(requestFor("/api/app/import/preview", importPayload([
      importSubscription(),
    ])), env);
    const json = await readSuccessData<{ summary: { skips: number; replaces: number }; items: Array<{ action: string; existingId?: string }> }>(response);

    expect(json.summary.skips).toBe(1);
    expect(json.summary.replaces).toBe(0);
    expect(json.items[0]).toMatchObject({ action: "skip", existingId: "sub_existing" });
  });

  it("restores renewlet billing records with remapped subscription ids and drops orphans", async () => {
    dbMocks.newId.mockImplementation((prefix: string) => (prefix === "bill" ? "bill_new" : "sub_new"));
    const { env, db, statements } = envFixture();
    const subscription = importSubscription({
      extra: { import: { source: "renewlet", sourceId: "sub_src", confidence: "high" } },
    });

    const response = await applyImport(requestFor("/api/app/import/apply", renewletRestorePayload({
      subscriptions: [subscription],
      groups: [{ id: "grp_src", name: "Work", sortOrder: 0 }],
      billingRecords: [
        importBillingRecord(),
        importBillingRecord({ id: "bill_orphan", subscriptionId: "sub_missing" }),
      ],
    })), env);
    const data = await readSuccessData<{
      includesGroups: boolean;
      groupsCount: number;
      includesBillingRecords: boolean;
      billingRecordsCount: number;
    }>(response);

    expect(response.status).toBe(200);
    // Worker 无分组表：计数如实回报但不产生任何 groups 写入；流水计数按包内条数回报。
    expect(data).toMatchObject({
      includesGroups: true,
      groupsCount: 1,
      includesBillingRecords: true,
      billingRecordsCount: 2,
    });
    const billingInserts = statements.filter((statement) => statement.sql.includes("INSERT INTO subscription_billing_records"));
    expect(billingInserts).toHaveLength(1);
    const values = billingInserts[0]?.values ?? [];
    // 源记录 id 不保留；宿主源 ID 已重映射到本次新建订阅；孤儿流水被丢弃。
    expect(values.slice(0, 6)).toEqual([
      "bill_new",
      authUser.id,
      "sub_new",
      "Record Plan",
      "2026-05-21",
      "2026-06-21",
    ]);
    expect(values[19]).toBe(JSON.stringify(["asset_receipt_1"]));
    expect(values[20]).toBe("2026-05-21T00:00:00.000Z");
    expect(values[21]).toBe("2026-06-05T00:00:00.000Z");
    expect(statements.some((statement) => /groups/i.test(statement.sql))).toBe(false);
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("attaches imported billing records to already-restored same-id subscriptions", async () => {
    // 模拟分块 apply 的后续块或同实例自恢复：订阅已在库中（含 renewlet:<id> 幂等键），
    // 本次无订阅写入，流水仍应挂到既有订阅 ID。
    dbMocks.listSubscriptions.mockResolvedValue([
      {
        id: "sub_src",
        user_id: authUser.id,
        name: "Imported",
        logo: null,
        price: "12",
        currency: "USD",
        billing_cycle: "monthly",
        custom_days: null,
        custom_cycle_unit: null,
        one_time_term_count: null,
        one_time_term_unit: null,
        usage_unit: null,
        usage_total: null,
        usage_daily_rate: null,
        usage_expires_at: null,
        category: "productivity",
        status: "active",
        pinned: 0,
        public_hidden: 0,
        payment_method: null,
        start_date: "2026-05-21",
        next_billing_date: "2026-06-21",
        auto_renew: 0,
        auto_calculate_next_billing_date: 1,
        trial_end_date: null,
        website: null,
        notes: null,
        tags_json: "[]",
        reminder_days: 3,
        repeat_reminder_enabled: 0,
        repeat_reminder_interval: "1h",
        repeat_reminder_window: "72h",
        cost_sharing_json: "{}",
        cost_sharing_collection_reminder_enabled: 0,
        cost_sharing_next_collection_reminder_date: null,
        extra_json: JSON.stringify({ import: { source: "renewlet", sourceId: "sub_src", confidence: "high" } }),
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      } satisfies SubscriptionRow,
    ]);
    dbMocks.newId.mockImplementation((prefix: string) => (prefix === "bill" ? "bill_new" : "sub_src"));
    const { env, statements } = envFixture();

    const response = await applyImport(requestFor("/api/app/import/apply", renewletRestorePayload({
      subscriptions: [importSubscription({
        extra: { import: { source: "renewlet", sourceId: "sub_src", confidence: "high" } },
      })],
      billingRecords: [importBillingRecord()],
    })), env);

    expect(response.status).toBe(200);
    expect(statements.some((statement) => statement.sql.includes("INSERT INTO subscriptions"))).toBe(false);
    const billingInsert = statements.find((statement) => statement.sql.includes("INSERT INTO subscription_billing_records"));
    expect(billingInsert?.values[2]).toBe("sub_src");
  });

  it("rejects groups and billing records outside renewlet exports", async () => {
    const { env, db } = envFixture();

    await expect(previewImport(requestFor("/api/app/import/preview", {
      payload: { source: "wallos", subscriptions: [], billingRecords: [importBillingRecord()] },
      conflictMode: "skip",
      skipIndexes: [],
    }), env)).rejects.toMatchObject({
      status: 400,
      code: "IMPORT_GROUPS_BILLING_RECORDS_SOURCE_INVALID",
    } satisfies Partial<HttpError>);
    expect(db.batch).not.toHaveBeenCalled();
  });
});
