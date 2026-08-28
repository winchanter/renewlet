// Worker 扣费记录测试保护事实快照的生成边界：行构造 helper、幂等 upsert、游标分页与订阅流程联动。
// list/patch 与订阅流程测试执行真实 SQL（node:sqlite + 0041 migration），避免 mock SQL 掩盖 schema drift。
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { DateOnly } from "@renewlet/shared/runtime";
import { readSuccessData } from "./api-test-helpers";
import {
  autoRenewBillingRecordRows,
  buildBillingRecordUpsertStatements,
  initialBillingRecordRow,
  listBillingRecords,
  manualRenewBillingRecordRow,
  toApiBillingRecord,
  updateBillingRecord,
} from "./billing-records";
import { renewAutoSubscriptionsForUserWithSettings } from "./subscription-renewal";
import type { SubscriptionRenewalResult } from "@renewlet/shared/subscription-renewal";
import { createSubscription, renewSubscription } from "./subscriptions";
import { subscriptionRowValues } from "./db";
import type { BillingRecordRow, Env, SubscriptionRow } from "./types";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

const USER_ID = "usr_billing_owner";
const OTHER_USER_ID = "usr_billing_intruder";
const TIMESTAMP = "2026-02-01T08:00:00.000Z";

function renewalResult(nextBillingDate: string, status: SubscriptionRenewalResult["status"] = "active"): SubscriptionRenewalResult {
  return { nextBillingDate: nextBillingDate as DateOnly, status };
}

function billingRecordRow(overrides: Partial<BillingRecordRow> = {}): BillingRecordRow {
  return {
    id: "bill_record",
    user_id: USER_ID,
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
    receipt_asset_ids: "[]",
    mode: "initial",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function subscriptionRow(id: string, overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id,
    user_id: USER_ID,
    name: `Subscription ${id}`,
    logo: null,
    price: "10",
    currency: "USD",
    billing_cycle: "monthly",
    custom_days: null,
    custom_cycle_unit: null,
    one_time_term_count: null,
    one_time_term_unit: null,
    usage_unit: null,
    usage_total: null,
    usage_daily_rate: null,
    category: "productivity",
    status: "active",
    pinned: 0,
    public_hidden: 0,
    payment_method: null,
    start_date: "2026-01-15",
    next_billing_date: "2026-09-15",
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
    extra_json: "{}",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://renewlet.test${path}`, {
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-renewlet-locale": "en-US",
      ...init.headers,
    },
    ...init,
  });
}

describe("Cloudflare billing records", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    authMocks.requireAuth.mockResolvedValue({ user: { id: USER_ID }, session: { id: "ses" } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("row builders", () => {
    it("snapshots the subscription into the initial billing record", () => {
      const row = subscriptionRow("sub_initial", { price: "30", currency: "CNY", start_date: "2026-05-14", next_billing_date: "2026-06-14" });
      const record = initialBillingRecordRow(row, TIMESTAMP, "bill_initial");

      expect(record).toEqual(billingRecordRow({
        id: "bill_initial",
        user_id: row.user_id,
        subscription_id: "sub_initial",
        name: row.name,
        billing_date: "2026-05-14",
        period_end_date: "2026-06-14",
        amount: "30",
        currency: "CNY",
        billing_cycle: "monthly",
        mode: "initial",
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      }));
    });

    it("falls back to the next billing date when the start date is unknown", () => {
      const row = subscriptionRow("sub_nostart", { start_date: null, next_billing_date: "2026-06-14" });
      const record = initialBillingRecordRow(row, TIMESTAMP, "bill_initial");

      expect(record.billing_date).toBe("2026-06-14");
      expect(record.period_end_date).toBe("2026-06-14");
    });

    it("continues a manual renewal over the pre-renewal billing date", () => {
      const existing = subscriptionRow("sub_manual", { status: "expired", start_date: "2026-01-31", next_billing_date: "2026-01-31" });
      const merged = { ...existing, status: "active", next_billing_date: "2026-02-28" } satisfies SubscriptionRow;
      const record = manualRenewBillingRecordRow(existing, merged, {
        mode: "continue",
        price: "15.5",
        currency: "EUR",
        startDate: null,
      }, TIMESTAMP, "bill_continue");

      expect(record.mode).toBe("manual_continue");
      expect(record.billing_date).toBe("2026-01-31");
      expect(record.period_end_date).toBe("2026-02-28");
      expect(record.amount).toBe("15.5");
      expect(record.currency).toBe("EUR");
    });

    it("restarts a manual renewal from the user-chosen purchase date", () => {
      const existing = subscriptionRow("sub_manual", { status: "expired", start_date: null, next_billing_date: "2026-01-31" });
      const merged = { ...existing, status: "active", start_date: "2026-08-12", next_billing_date: "2026-09-12" } satisfies SubscriptionRow;
      const record = manualRenewBillingRecordRow(existing, merged, {
        mode: "restart",
        price: "20",
        currency: "USD",
        startDate: "2026-08-12",
      }, TIMESTAMP, "bill_restart");

      expect(record.mode).toBe("manual_restart");
      expect(record.billing_date).toBe("2026-08-12");
      expect(record.period_end_date).toBe("2026-09-12");
      expect(record.amount).toBe("20");
    });

    it("writes one auto record per covered period between the old and new billing dates", () => {
      const before = subscriptionRow("sub_auto", { price: "10", currency: "USD", next_billing_date: "2026-06-15" });
      const ids = ["bill_auto_1", "bill_auto_2", "bill_auto_3"];
      let index = 0;
      const rows = autoRenewBillingRecordRows(before, renewalResult("2026-09-15"), TIMESTAMP, () => ids[index++]!);

      expect(rows.map((row) => row.billing_date)).toEqual(["2026-06-15", "2026-07-15", "2026-08-15"]);
      expect(rows.map((row) => row.period_end_date)).toEqual(["2026-07-15", "2026-08-15", "2026-09-15"]);
      expect(rows.map((row) => row.id)).toEqual(ids);
      expect(rows.every((row) => row.mode === "auto" && row.amount === "10" && row.currency === "USD")).toBe(true);
    });

    it("skips auto records for usage-based and up-to-date subscriptions", () => {
      const usageRow = subscriptionRow("sub_usage", {
        billing_cycle: "usage-based",
        usage_unit: "GB",
        usage_total: 100,
        usage_daily_rate: 2,
      });
      expect(autoRenewBillingRecordRows(usageRow, renewalResult("2026-12-31"), TIMESTAMP)).toEqual([]);
      expect(autoRenewBillingRecordRows(
        subscriptionRow("sub_current"),
        renewalResult("2026-09-15"),
        TIMESTAMP,
      )).toEqual([]);
    });

    it("aborts beyond the auto record cycle limit instead of looping forever", () => {
      const before = subscriptionRow("sub_dirty", { billing_cycle: "weekly", next_billing_date: "1500-01-01" });
      expect(() => autoRenewBillingRecordRows(before, renewalResult("2026-01-01"), TIMESTAMP))
        .toThrow("SUBSCRIPTION_RENEWAL_ADVANCE_LIMIT_EXCEEDED");
    });
  });

  describe("upsert statements against real SQL", () => {
    it("keeps identity columns stable and refreshes facts on replay", async () => {
      const { db, env } = openBillingRecordDatabase();
      try {
        const first = billingRecordRow({ id: "bill_first", amount: "12", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
        await env.DB.batch(buildBillingRecordUpsertStatements(env, [first]));
        const replay = billingRecordRow({
          id: "bill_second",
          amount: "18",
          period_end_date: "2026-03-31",
          created_at: "2026-02-02T00:00:00.000Z",
          updated_at: "2026-02-02T00:00:00.000Z",
        });
        await env.DB.batch(buildBillingRecordUpsertStatements(env, [replay]));

        const rows = db.prepare("SELECT * FROM subscription_billing_records").all() as unknown as BillingRecordRow[];
        expect(rows).toHaveLength(1);
        // 幂等键命中后 id 与 created_at 保持首写事实，重放只更新快照事实列。
        expect(rows[0]).toMatchObject({
          id: "bill_first",
          created_at: "2026-01-01T00:00:00.000Z",
          amount: "18",
          period_end_date: "2026-03-31",
          updated_at: "2026-02-02T00:00:00.000Z",
        });
      } finally {
        db.close();
      }
    });

    it("keeps the same billing date in different modes as separate facts", async () => {
      const { db, env } = openBillingRecordDatabase();
      try {
        await env.DB.batch(buildBillingRecordUpsertStatements(env, [
          billingRecordRow({ id: "bill_initial", mode: "initial", amount: "12" }),
          billingRecordRow({ id: "bill_continue", mode: "manual_continue", amount: "15.5" }),
        ]));

        const rows = db.prepare("SELECT id, mode, amount FROM subscription_billing_records ORDER BY id").all();
        expect(rows).toEqual([
          { id: "bill_continue", mode: "manual_continue", amount: "15.5" },
          { id: "bill_initial", mode: "initial", amount: "12" },
        ]);
      } finally {
        db.close();
      }
    });
  });

  describe("api mapper", () => {
    it("maps fixed cycles without optional cycle fields", () => {
      const record = toApiBillingRecord(billingRecordRow());
      expect(record.billingCycle).toBe("monthly");
      expect(record).not.toHaveProperty("customDays");
      expect(record).not.toHaveProperty("customCycleUnit");
      expect(record).not.toHaveProperty("oneTimeTermCount");
      expect(record).not.toHaveProperty("oneTimeTermUnit");
      expect(record).not.toHaveProperty("usageUnit");
    });

    it("maps custom, one-time, and usage cycle fields as consistent groups", () => {
      const custom = toApiBillingRecord(billingRecordRow({
        billing_cycle: "custom",
        custom_days: 45,
        custom_cycle_unit: "day",
      }));
      expect(custom).toMatchObject({ customDays: 45, customCycleUnit: "day" });
      expect(custom).not.toHaveProperty("usageUnit");

      const oneTime = toApiBillingRecord(billingRecordRow({
        billing_cycle: "one-time",
        one_time_term_count: 6,
        one_time_term_unit: "month",
      }));
      expect(oneTime).toMatchObject({ oneTimeTermCount: 6, oneTimeTermUnit: "month" });

      // usage 三字段必须成组出现；快照完整性由写入边界保证，缺失日均的行在出站门就会被整体拒绝。
      const usage = toApiBillingRecord(billingRecordRow({
        billing_cycle: "usage-based",
        usage_unit: "GB",
        usage_total: 100,
        usage_daily_rate: 2,
      }));
      expect(usage).toMatchObject({ usageUnit: "GB", usageTotal: 100, usageDailyRate: 2 });
    });
  });

  describe("list handler", () => {
    it("pages by (billing_date, id) desc with an owner-scoped total", async () => {
      const { db, env } = openBillingRecordDatabase();
      try {
        await env.DB.batch(buildBillingRecordUpsertStatements(env, [
          billingRecordRow({ id: "bill_rec_d", billing_date: "2026-03-01", period_end_date: "2026-04-01", mode: "auto" }),
          billingRecordRow({ id: "bill_rec_z", billing_date: "2026-02-01", period_end_date: "2026-03-01", mode: "auto" }),
          billingRecordRow({ id: "bill_rec_a", billing_date: "2026-02-01", period_end_date: "2026-03-01", mode: "manual_continue" }),
          billingRecordRow({ id: "bill_rec_b", billing_date: "2026-01-01", period_end_date: "2026-02-01", mode: "initial" }),
          billingRecordRow({ id: "bill_rec_x", user_id: OTHER_USER_ID, billing_date: "2026-05-01", period_end_date: "2026-06-01" }),
        ]));

        const firstPage = await listBillingRecords(
          request("/api/app/subscriptions/sub_record/billing-records?limit=3"),
          env,
          "sub_record",
        );
        const firstBody = await readSuccessData<{ records: Array<{ id: string }>; nextCursor: string | null; total: number }>(firstPage);
        expect(firstBody.total).toBe(4);
        // 同一 billing_date 下按 id DESC 决胜；他人记录不得进入本用户游标流。
        expect(firstBody.records.map((record) => record.id)).toEqual(["bill_rec_d", "bill_rec_z", "bill_rec_a"]);
        expect(firstBody.nextCursor).toBe("2026-02-01~bill_rec_a");

        const secondPage = await listBillingRecords(
          request(`/api/app/subscriptions/sub_record/billing-records?limit=3&cursor=${encodeURIComponent(firstBody.nextCursor!)}`),
          env,
          "sub_record",
        );
        const secondBody = await readSuccessData<{ records: Array<{ id: string }>; nextCursor: string | null; total: number }>(secondPage);
        expect(secondBody.records.map((record) => record.id)).toEqual(["bill_rec_b"]);
        expect(secondBody.nextCursor).toBeNull();
        expect(secondBody.total).toBe(4);
      } finally {
        db.close();
      }
    });

    it("rejects cursors that do not decode to a valid keyset", async () => {
      const { db, env } = openBillingRecordDatabase();
      try {
        await expect(listBillingRecords(
          request("/api/app/subscriptions/sub_record/billing-records?cursor=2026-13-01~bill_rec_a"),
          env,
          "sub_record",
        )).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
        await expect(listBillingRecords(
          request("/api/app/subscriptions/sub_record/billing-records?cursor=no-separator"),
          env,
          "sub_record",
        )).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
      } finally {
        db.close();
      }
    });
  });

  describe("patch handler", () => {
    it("merges amount-only patches and keeps the period snapshot", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(TIMESTAMP));
      const { db, env } = openBillingRecordDatabase();
      try {
        await env.DB.batch(buildBillingRecordUpsertStatements(env, [billingRecordRow({ id: "bill_fix" })]));

        const response = await updateBillingRecord(request("/api/app/billing-records/bill_fix", {
          method: "PATCH",
          body: JSON.stringify({ amount: "15.5", currency: "EUR" }),
        }), env, "bill_fix");
        const body = await readSuccessData<{ record: { amount: string; currency: string; billingDate: string; periodEndDate: string; updatedAt: string } }>(response);

        expect(body.record).toMatchObject({
          amount: "15.5",
          currency: "EUR",
          billingDate: "2026-01-31",
          periodEndDate: "2026-02-28",
          updatedAt: TIMESTAMP,
        });
        expect(db.prepare("SELECT amount, period_end_date FROM subscription_billing_records WHERE id = ?").get("bill_fix"))
          .toEqual({ amount: "15.5", period_end_date: "2026-02-28" });
      } finally {
        db.close();
      }
    });

    it("recalculates the period end when a period-touching field is patched", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(TIMESTAMP));
      const { db, env } = openBillingRecordDatabase();
      try {
        await env.DB.batch(buildBillingRecordUpsertStatements(env, [billingRecordRow({ id: "bill_fix" })]));

        const response = await updateBillingRecord(request("/api/app/billing-records/bill_fix", {
          method: "PATCH",
          body: JSON.stringify({ billingDate: "2026-03-15" }),
        }), env, "bill_fix");
        const body = await readSuccessData<{ record: { billingDate: string; periodEndDate: string } }>(response);

        // 编辑重算锚点固定为编辑后的扣费日：monthly 2026-03-15 的一期到期日是 2026-04-15。
        expect(body.record.periodEndDate).toBe("2026-04-15");
        expect(db.prepare("SELECT period_end_date FROM subscription_billing_records WHERE id = ?").get("bill_fix"))
          .toEqual({ period_end_date: "2026-04-15" });
      } finally {
        db.close();
      }
    });

    it("rejects unknown records, foreign owners, and inconsistent payloads", async () => {
      const { db, env } = openBillingRecordDatabase();
      try {
        await env.DB.batch(buildBillingRecordUpsertStatements(env, [
          billingRecordRow({ id: "bill_fix" }),
          billingRecordRow({ id: "bill_foreign", user_id: OTHER_USER_ID }),
        ]));

        await expect(updateBillingRecord(request("/api/app/billing-records/bill_missing", {
          method: "PATCH",
          body: JSON.stringify({ amount: "1" }),
        }), env, "bill_missing")).rejects.toMatchObject({ status: 404 });
        await expect(updateBillingRecord(request("/api/app/billing-records/bill_foreign", {
          method: "PATCH",
          body: JSON.stringify({ amount: "1" }),
        }), env, "bill_foreign")).rejects.toMatchObject({ status: 404 });
        await expect(updateBillingRecord(request("/api/app/billing-records/bill_fix", {
          method: "PATCH",
          body: JSON.stringify({ currency: "usd" }),
        }), env, "bill_fix")).rejects.toMatchObject({ status: 400 });
        await expect(updateBillingRecord(request("/api/app/billing-records/bill_fix", {
          method: "PATCH",
          body: JSON.stringify({}),
        }), env, "bill_fix")).rejects.toMatchObject({ status: 400 });
        // 切换到 custom 周期但缺少 customDays：合并后的完整记录必须被 schema 拒绝。
        await expect(updateBillingRecord(request("/api/app/billing-records/bill_fix", {
          method: "PATCH",
          body: JSON.stringify({ billingCycle: "custom" }),
        }), env, "bill_fix")).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
        expect(db.prepare("SELECT COUNT(*) AS count FROM subscription_billing_records").get())
          .toEqual({ count: 2 });
      } finally {
        db.close();
      }
    });
  });

  describe("subscription flow integration", () => {
    it("creates the initial billing record together with the subscription", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(TIMESTAMP));
      const { db, env } = openBillingRecordDatabase();
      try {
        const response = await createSubscription(request("/api/app/subscriptions", {
          method: "POST",
          body: JSON.stringify(subscriptionCreateBody()),
        }), env);
        expect(response.status).toBe(201);

        const rows = db.prepare("SELECT * FROM subscription_billing_records").all() as unknown as BillingRecordRow[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          mode: "initial",
          billing_date: "2026-05-14",
          period_end_date: "2026-06-14",
          amount: "30",
          currency: "USD",
          name: "Three Year Plan",
          user_id: USER_ID,
          created_at: TIMESTAMP,
        });
        expect(db.prepare("SELECT id FROM subscriptions WHERE id = ?").get(rows[0]!.subscription_id)).toBeTruthy();
      } finally {
        db.close();
      }
    });

    it("writes a manual_continue record covering the pre-renewal billing date", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-02-01T08:00:00.000Z"));
      const { db, env } = openBillingRecordDatabase();
      try {
        insertSubscription(db, subscriptionRow("sub_manual", {
          name: "Manual Plan",
          status: "expired",
          price: "12",
          start_date: "2026-01-31",
          next_billing_date: "2026-01-31",
        }));
        // 直接落库绕过了派生计划；统计基线必须先对齐已有订阅，update 增量（expired→active）才不会击穿 CHECK。
        db.prepare("UPDATE subscription_user_stats SET total_count = 1, expired_count = 1 WHERE user_id = ?").run(USER_ID);

        const response = await renewSubscription(request("/api/app/subscriptions/sub_manual/renew", {
          method: "POST",
          body: JSON.stringify({
            mode: "continue",
            price: "15.500000",
            currency: "EUR",
            startDate: null,
            nextBillingDate: "2026-03-01",
            autoCalculateNextBillingDate: false,
          }),
        }), env, "sub_manual");
        expect(response.status).toBe(200);

        const rows = db.prepare("SELECT * FROM subscription_billing_records").all() as unknown as BillingRecordRow[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          mode: "manual_continue",
          billing_date: "2026-01-31",
          period_end_date: "2026-02-28",
          amount: "15.5",
          currency: "EUR",
          name: "Manual Plan",
        });
        expect(db.prepare("SELECT next_billing_date, status, price, currency FROM subscriptions WHERE id = ?").get("sub_manual"))
          .toEqual({ next_billing_date: "2026-02-28", status: "active", price: "15.5", currency: "EUR" });
      } finally {
        db.close();
      }
    });

    it("writes a manual_restart record from the new purchase date", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-12T08:00:00.000Z"));
      const { db, env } = openBillingRecordDatabase();
      try {
        insertSubscription(db, subscriptionRow("sub_manual", {
          name: "Manual Plan",
          status: "expired",
          start_date: null,
          next_billing_date: "2026-01-31",
          auto_calculate_next_billing_date: 0,
        }));
        db.prepare("UPDATE subscription_user_stats SET total_count = 1, expired_count = 1 WHERE user_id = ?").run(USER_ID);

        const response = await renewSubscription(request("/api/app/subscriptions/sub_manual/renew", {
          method: "POST",
          body: JSON.stringify({
            mode: "restart",
            price: "20",
            currency: "USD",
            startDate: "2026-08-12",
            nextBillingDate: "2026-09-12",
            autoCalculateNextBillingDate: true,
          }),
        }), env, "sub_manual");
        expect(response.status).toBe(200);

        const rows = db.prepare("SELECT * FROM subscription_billing_records").all() as unknown as BillingRecordRow[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          mode: "manual_restart",
          billing_date: "2026-08-12",
          period_end_date: "2026-09-12",
          amount: "20",
          currency: "USD",
        });
      } finally {
        db.close();
      }
    });

    it("writes one auto record per covered period and stays idempotent per local date", async () => {
      const { db, env } = openBillingRecordDatabase();
      try {
        insertSubscription(db, subscriptionRow("sub_auto", {
          auto_renew: 1,
          start_date: "2026-01-15",
          next_billing_date: "2026-06-15",
        }));
        db.prepare("UPDATE subscription_scheduler_state SET auto_renew_count = 1 WHERE user_id = ?").run(USER_ID);

        const now = new Date("2026-08-17T00:00:00.000Z");
        const updated = await renewAutoSubscriptionsForUserWithSettings(env, USER_ID, createDefaultAppSettings(), now);
        expect(updated).toBe(1);

        // 旧账单日 2026-06-15 到新账单日 2026-09-15 之间覆盖 3 期，每期一条 mode=auto 记录。
        const rows = db.prepare(`
          SELECT billing_date, period_end_date, mode, amount, currency, name
          FROM subscription_billing_records ORDER BY billing_date
        `).all();
        expect(rows).toEqual([
          { billing_date: "2026-06-15", period_end_date: "2026-07-15", mode: "auto", amount: "10", currency: "USD", name: "Subscription sub_auto" },
          { billing_date: "2026-07-15", period_end_date: "2026-08-15", mode: "auto", amount: "10", currency: "USD", name: "Subscription sub_auto" },
          { billing_date: "2026-08-15", period_end_date: "2026-09-15", mode: "auto", amount: "10", currency: "USD", name: "Subscription sub_auto" },
        ]);
        expect(db.prepare("SELECT next_billing_date FROM subscriptions WHERE id = ?").get("sub_auto"))
          .toEqual({ next_billing_date: "2026-09-15" });

        // 同一本地日期内重复执行必须被 scheduler gate 拦截，不能产生重复记录。
        const repeated = await renewAutoSubscriptionsForUserWithSettings(env, USER_ID, createDefaultAppSettings(), now);
        expect(repeated).toBe(0);
        expect(readBillingRecordCount(db)).toBe(3);
      } finally {
        db.close();
      }
    });
  });
});

function subscriptionCreateBody() {
  return {
    name: "Three Year Plan",
    logo: null,
    price: "30",
    currency: "USD",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: null,
    startDate: "2026-05-14",
    nextBillingDate: "2026-06-14",
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
    extra: {},
  };
}

function insertSubscription(db: DatabaseSync, row: SubscriptionRow): void {
  db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
      usage_unit, usage_total, usage_daily_rate,
      category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
      trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
      cost_sharing_json, cost_sharing_collection_reminder_enabled, cost_sharing_next_collection_reminder_date, extra_json, created_at, updated_at
    ) VALUES (${subscriptionRowValues(row).map(() => "?").join(", ")})
  `).run(...(subscriptionRowValues(row) as SQLInputValue[]));
}

function readBillingRecordCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM subscription_billing_records").get();
  return Number(row?.["count"] ?? 0);
}

/**
 * 打开带扣费记录表的内存库：派生状态 schema 与 0041 migration 全部真实执行，
 * 让订阅流程 batch 与 list/patch SQL 在测试里走和 D1 相同的语句形状。
 */
function openBillingRecordDatabase(): { db: DatabaseSync; env: Env } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE settings (user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      logo TEXT,
      price TEXT NOT NULL,
      currency TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      custom_days INTEGER,
      custom_cycle_unit TEXT,
      one_time_term_count INTEGER,
      one_time_term_unit TEXT,
      usage_unit TEXT,
      usage_total REAL,
      usage_daily_rate REAL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      public_hidden INTEGER NOT NULL,
      payment_method TEXT,
      start_date TEXT,
      next_billing_date TEXT NOT NULL,
      auto_renew INTEGER NOT NULL,
      auto_calculate_next_billing_date INTEGER NOT NULL,
      trial_end_date TEXT,
      website TEXT,
      notes TEXT,
      tags_json TEXT NOT NULL,
      reminder_days INTEGER NOT NULL,
      repeat_reminder_enabled INTEGER NOT NULL,
      repeat_reminder_interval TEXT NOT NULL,
      repeat_reminder_window TEXT NOT NULL,
      cost_sharing_json TEXT NOT NULL,
      cost_sharing_collection_reminder_enabled INTEGER NOT NULL,
      cost_sharing_next_collection_reminder_date TEXT,
      extra_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_list_index (
      subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      website TEXT,
      notes TEXT,
      search_text_lower TEXT NOT NULL,
      category TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      currency TEXT NOT NULL,
      payment_method TEXT,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      public_hidden INTEGER NOT NULL,
      next_billing_date TEXT NOT NULL,
      trial_end_date TEXT,
      one_time_term_count INTEGER,
      auto_renew INTEGER NOT NULL,
      reminder_days INTEGER NOT NULL,
      repeat_reminder_enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_tags (
      user_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      tag_norm TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, subscription_id, tag_norm)
    );
    CREATE TABLE subscription_user_stats (
      user_id TEXT PRIMARY KEY,
      total_count INTEGER NOT NULL,
      trial_count INTEGER NOT NULL,
      active_count INTEGER NOT NULL,
      expired_count INTEGER NOT NULL,
      paused_count INTEGER NOT NULL,
      cancelled_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (total_count >= 0 AND trial_count >= 0 AND active_count >= 0 AND expired_count >= 0 AND paused_count >= 0 AND cancelled_count >= 0),
      CHECK (total_count = trial_count + active_count + expired_count + paused_count + cancelled_count)
    );
    CREATE TABLE subscription_repeat_schedule (
      user_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      next_due_at_utc TEXT NOT NULL,
      PRIMARY KEY (user_id, subscription_id)
    );
    CREATE TABLE subscription_scheduler_state (
      user_id TEXT PRIMARY KEY,
      auto_renew_count INTEGER NOT NULL,
      repeat_reminder_count INTEGER NOT NULL,
      last_auto_renew_local_date TEXT NOT NULL,
      next_auto_renew_check_at_utc TEXT,
      next_daily_notification_due_at_utc TEXT,
      next_repeat_notification_due_at_utc TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO users (id) VALUES ('${USER_ID}'), ('${OTHER_USER_ID}');
    INSERT INTO settings (user_id, settings_json) VALUES ('${USER_ID}', '{}');
    INSERT INTO subscription_user_stats (
      user_id, total_count, trial_count, active_count, expired_count, paused_count, cancelled_count, created_at, updated_at
    ) VALUES ('${USER_ID}', 0, 0, 0, 0, 0, 0, '${TIMESTAMP}', '${TIMESTAMP}');
    INSERT INTO subscription_scheduler_state (
      user_id, auto_renew_count, repeat_reminder_count, last_auto_renew_local_date,
      next_auto_renew_check_at_utc, next_daily_notification_due_at_utc, next_repeat_notification_due_at_utc,
      created_at, updated_at
    ) VALUES ('${USER_ID}', 0, 0, '', NULL, NULL, NULL, '${TIMESTAMP}', '${TIMESTAMP}');
  `);
  db.exec(readFileSync(resolve("migrations", "0041_billing_records.sql"), "utf8"));
  db.exec(readFileSync(resolve("migrations", "0042_billing_records_receipts.sql"), "utf8"));
  return { db, env: { DB: new SqliteD1Database(db) as unknown as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket } as Env };
}

class SqliteD1Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements: SqliteD1PreparedStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteD1PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return this.db.prepare(this.sql).get(...this.values) as T | undefined ?? null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.runSync();
  }

  runSync(): { meta: { changes: number } } {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}
