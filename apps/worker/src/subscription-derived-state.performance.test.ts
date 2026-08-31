import {
  buildSubscriptionPerformanceScenario,
  subscriptionPerformanceFixture,
  type SubscriptionPerformanceRecord,
} from "@renewlet/shared/contract-fixtures";
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import { describe, expect, it } from "vitest";
import { subscriptionDerivedMutationPlan, type SubscriptionDerivedMutation } from "./subscription-derived-state";
import type { Env, SubscriptionRow } from "./types";

class PerformanceD1Database {
  readonly prepared: PerformanceD1PreparedStatement[] = [];

  prepare(sql: string): D1PreparedStatement {
    const statement = new PerformanceD1PreparedStatement(sql);
    this.prepared.push(statement);
    return statement as unknown as D1PreparedStatement;
  }
}

class PerformanceD1PreparedStatement {
  params: unknown[] = [];

  constructor(readonly sql: string) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }
}

describe.each(subscriptionPerformanceFixture.scenarios)("Worker derived mutation budget: $size", (scenario) => {
  it("keeps create/update/delete/renew independent of the user's collection size", () => {
    const { initial, final } = buildSubscriptionPerformanceScenario(scenario.size);
    const database = new PerformanceD1Database();
    const env = {
      DB: database as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } satisfies Env;
    const mutations = performanceMutations(initial, final, scenario.size);
    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();

    for (const mutation of mutations) {
      database.prepared.length = 0;
      const plan = subscriptionDerivedMutationPlan(env, mutation, createDefaultAppSettings(), new Date("2026-08-17T00:00:00Z"));
      const statements = [...plan.beforeFact, ...plan.afterFact];
      const uniqueTagCount = mutation.after
        ? new Set(JSON.parse(mutation.after.tags_json).map((tag: string) => tag.trim().toLocaleLowerCase()).filter(Boolean)).size
        : 0;

      expect(statements.length).toBeLessThanOrEqual(scenario.operationBudget.derivedWriteBase + uniqueTagCount);
      expect(database.prepared.some(({ sql }) => /DELETE FROM subscription_(?:list_index|tags|repeat_schedule)\s+WHERE user_id = \?\s*$/m.test(sql))).toBe(false);
      const factReads = database.prepared.filter(({ sql }) => /FROM subscriptions\b/.test(sql));
      expect(factReads).toHaveLength(mutation.kind === "create" ? 0 : 1);
      expect(factReads.every(({ sql }) => /WHERE user_id = \? AND id = \?/.test(sql))).toBe(true);
      expect(database.prepared.some(({ sql }) => /status_counts_json|source_updated_at/.test(sql))).toBe(false);
    }

    // operation 数是 CI 硬门；共享 runner 的毫秒值和 RSS 只输出趋势。
    console.info(`[perf] worker n=${scenario.size} elapsed_ms=${(performance.now() - startedAt).toFixed(2)} rss_delta=${process.memoryUsage().rss - rssBefore}`);
  });
});

function performanceMutations(
  initial: SubscriptionPerformanceRecord[],
  final: SubscriptionPerformanceRecord[],
  size: number,
): SubscriptionDerivedMutation[] {
  const initialByIndex = new Map(initial.map((record) => [record.index, toSubscriptionRow(record)]));
  const finalByIndex = new Map(final.map((record) => [record.index, toSubscriptionRow(record)]));
  return [
    { kind: "update", before: requiredRow(initialByIndex, 1), after: requiredRow(finalByIndex, 1) },
    { kind: "update", before: requiredRow(initialByIndex, 2), after: requiredRow(finalByIndex, 2) },
    { kind: "delete", before: requiredRow(initialByIndex, 3), after: null },
    { kind: "create", before: null, after: requiredRow(finalByIndex, size) },
  ];
}

function requiredRow(rows: Map<number, SubscriptionRow>, index: number): SubscriptionRow {
  const row = rows.get(index);
  if (!row) throw new Error(`Missing performance row ${index}`);
  return row;
}

function toSubscriptionRow(record: SubscriptionPerformanceRecord): SubscriptionRow {
  return {
    id: record.id,
    user_id: "subscription-perf-owner",
    name: record.name,
    logo: null,
    price: record.price,
    currency: record.currency,
    billing_cycle: record.billingCycle,
    custom_days: record.customDays,
    custom_cycle_unit: record.customCycleUnit,
    one_time_term_count: null,
    one_time_term_unit: null,
    usage_unit: null,
    usage_total: null,
    usage_daily_rate: null,
    usage_expires_at: null,
    category: record.category,
    status: record.status,
    pinned: Number(record.pinned),
    public_hidden: Number(record.publicHidden),
    payment_method: record.paymentMethod,
    start_date: record.startDate,
    next_billing_date: record.nextBillingDate,
    auto_renew: Number(record.autoRenew),
    auto_calculate_next_billing_date: Number(record.autoCalculateNextBillingDate),
    trial_end_date: record.trialEndDate,
    website: record.website,
    notes: record.notes,
    tags_json: JSON.stringify(record.tags),
    reminder_days: record.reminderDays,
    repeat_reminder_enabled: Number(record.repeatReminderEnabled),
    repeat_reminder_interval: record.repeatReminderInterval,
    repeat_reminder_window: record.repeatReminderWindow,
    cost_sharing_json: "{}",
    cost_sharing_collection_reminder_enabled: 0,
    cost_sharing_next_collection_reminder_date: null,
    extra_json: "{}",
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}
