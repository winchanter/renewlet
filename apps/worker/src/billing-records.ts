/**
 * Cloudflare 扣费记录 handler 是 shared billing-records 契约与 D1 subscription_billing_records 表之间的读写收敛层。
 *
 * 记录是订阅每期扣费的事实快照：生成时从订阅复制字段，之后独立演化；归属（subscriptionId）与
 * 来源（mode、name 快照）不可改，PATCH 只开放事实修正字段。所有写入与订阅事实共用同一 D1 batch。
 */
import {
  apiBillingRecordSchema,
  billingRecordPatchBodySchema,
  billingRecordPatchTouchesPeriod,
  billingRecordsListPayloadSchema,
  billingRecordPayloadSchema,
  billingRecordsListQuerySchema,
  computeBillingRecordPeriodEnd,
  decodeBillingRecordCursor,
  encodeBillingRecordCursor,
  type ApiBillingRecord,
  type BillingRecordPatchBody,
} from "@renewlet/shared/schemas/billing-records";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";
import type { BillingRecordMode, BillingCycle, CustomCycleUnit } from "@renewlet/shared/runtime";
import type { SubscriptionRenewalResult } from "@renewlet/shared/subscription-renewal";
import { addBillingCycles } from "@renewlet/shared/subscription-renewal";
import { newId, nowIso } from "./db";
import { HttpError, readJson, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import { requireAuth } from "./auth";
import type { BillingRecordRow, Env, SubscriptionRow } from "./types";
import { z } from "zod";

export const BILLING_RECORD_COLUMN_NAMES = [
  "id",
  "user_id",
  "subscription_id",
  "name",
  "billing_date",
  "period_end_date",
  "amount",
  "currency",
  "billing_cycle",
  "custom_days",
  "custom_cycle_unit",
  "one_time_term_count",
  "one_time_term_unit",
  "usage_unit",
  "usage_total",
  "usage_daily_rate",
  "mode",
  "receipt_asset_ids",
  "created_at",
  "updated_at",
] as const;

export const BILLING_RECORD_COLUMNS = BILLING_RECORD_COLUMN_NAMES.join(", ");

/** 自动续订记录按覆盖期逐条生成；上限与 shared MAX_ADVANCE_CYCLES 语义对齐，防脏数据把 Cron 拖死。 */
const MAX_AUTO_RECORD_CYCLES = 20_000;

/** 记录 ID 前缀沿用 D1 领域前缀惯例，便于日志和导入排查。 */
export const BILLING_RECORD_ID_PREFIX = "bill";

/** D1 行到 shared 记录的唯一出站门；周期字段成组缺席，避免读取方误用历史总量。 */
export function toApiBillingRecord(row: BillingRecordRow): ApiBillingRecord {
  return apiBillingRecordSchema.parse({
    id: row.id,
    subscriptionId: row.subscription_id,
    name: row.name,
    billingDate: row.billing_date,
    periodEndDate: row.period_end_date,
    amount: row.amount,
    currency: row.currency,
    mode: row.mode as BillingRecordMode,
    billingCycle: row.billing_cycle as ApiBillingRecord["billingCycle"],
    ...(row.custom_days === null ? {} : { customDays: row.custom_days }),
    ...(row.custom_cycle_unit === null ? {} : { customCycleUnit: row.custom_cycle_unit }),
    ...(row.one_time_term_count !== null && row.one_time_term_unit !== null
      ? { oneTimeTermCount: row.one_time_term_count, oneTimeTermUnit: row.one_time_term_unit }
      : {}),
    ...(row.billing_cycle === "usage-based" && row.usage_unit !== null && row.usage_total !== null && row.usage_daily_rate !== null
      ? { usageUnit: row.usage_unit, usageTotal: row.usage_total, usageDailyRate: row.usage_daily_rate }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    receiptAssetIds: parseReceiptAssetIds(row.receipt_asset_ids),
  });
}

/** D1 存 JSON 字符串；旧记录无此列或 NULL 时收敛为空数组，保证出站形状稳定。 */
function parseReceiptAssetIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

/** 记录列表是订阅详情的附属读取；owner 与订阅归属共同过滤，游标不能跨用户复用。 */
export async function listBillingRecords(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const url = new URL(request.url);
  const parsed = billingRecordsListQuerySchema.parse(listQueryInput(url.searchParams));
  const cursor = parsed.cursor ? decodeBillingRecordCursor(parsed.cursor) : null;
  if (parsed.cursor && !cursor) {
    throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "INVALID_CURSOR");
  }
  // 游标排序字段必须和 ORDER BY 完全一致，避免同一 billing_date 下漏读或重复读。
  const page = cursor
    ? await env.DB.prepare(`
        SELECT ${BILLING_RECORD_COLUMNS} FROM subscription_billing_records
        WHERE user_id = ? AND subscription_id = ?
          AND (billing_date < ? OR (billing_date = ? AND id < ?))
        ORDER BY billing_date DESC, id DESC
        LIMIT ?
      `).bind(auth.user.id, subscriptionId, cursor.billingDate, cursor.billingDate, cursor.id, parsed.limit + 1)
      .all<BillingRecordRow>()
    : await env.DB.prepare(`
        SELECT ${BILLING_RECORD_COLUMNS} FROM subscription_billing_records
        WHERE user_id = ? AND subscription_id = ?
        ORDER BY billing_date DESC, id DESC
        LIMIT ?
      `).bind(auth.user.id, subscriptionId, parsed.limit + 1).all<BillingRecordRow>();
  const totalRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM subscription_billing_records WHERE user_id = ? AND subscription_id = ?",
  ).bind(auth.user.id, subscriptionId).first<{ count: number }>();
  // 多取 1 行只为判断 hasMore；出站前必须裁剪回 limit，避免响应形状随翻页漂移。
  const hasMore = page.results.length > parsed.limit;
  const pageRows = hasMore ? page.results.slice(0, parsed.limit) : page.results;
  const lastRow = pageRows.at(-1);
  const nextCursor = hasMore && lastRow
    ? encodeBillingRecordCursor({ billingDate: lastRow.billing_date, id: lastRow.id })
    : null;
  return successJson(billingRecordsListPayloadSchema.parse({
    records: pageRows.map(toApiBillingRecord),
    nextCursor,
    total: totalRow?.count ?? 0,
  }));
}

/** PATCH 只允许事实修正；归属与来源字段不在此列，owner 过滤复用订阅 handler 的同款语义。 */
export async function updateBillingRecord(request: Request, env: Env, recordId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const patch = await readJson(request, billingRecordPatchBodySchema, locale);
  const row = await env.DB.prepare(
    `SELECT ${BILLING_RECORD_COLUMNS} FROM subscription_billing_records WHERE user_id = ? AND id = ? LIMIT 1`,
  ).bind(auth.user.id, recordId).first<BillingRecordRow>();
  if (!row) throw new HttpError(404, serverText(locale, "subscription.notFound"));

  const timestamp = nowIso();
  let record: ApiBillingRecord = billingRecordPatchCandidate(row, patch, timestamp);
  if (billingRecordPatchTouchesPeriod(patch)) {
    let periodEndDate: string | null;
    try {
      // 编辑重算锚点固定为编辑后的扣费日；usage 字段非法或推算失败必须与写入边界共用同一 400 语义。
      // 扣费日前移可能越过旧 period_end_date，必须先重算到期日再整体校验，否则合法修正会被旧快照误拒。
      periodEndDate = computeBillingRecordPeriodEnd(record);
    } catch {
      throw new HttpError(400, serverText(locale, "common.invalidPayload"), "INVALID_PAYLOAD");
    }
    record = { ...record, periodEndDate };
  }
  // 合并（含重算）后的最终记录必须通过完整记录 schema；ZodError 与写入边界共用同一 400 语义。
  try {
    record = apiBillingRecordSchema.parse(record);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new HttpError(400, serverText(locale, "common.invalidPayload"), "INVALID_PAYLOAD", error.flatten());
    }
    throw error;
  }
  await env.DB.prepare(`
    UPDATE subscription_billing_records SET
      billing_date = ?, period_end_date = ?, amount = ?, currency = ?, billing_cycle = ?,
      custom_days = ?, custom_cycle_unit = ?, one_time_term_count = ?, one_time_term_unit = ?,
      usage_unit = ?, usage_total = ?, usage_daily_rate = ?, receipt_asset_ids = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `).bind(
    record.billingDate,
    record.periodEndDate,
    record.amount,
    record.currency,
    record.billingCycle,
    record.customDays ?? null,
    record.customCycleUnit ?? null,
    record.oneTimeTermCount ?? null,
    record.oneTimeTermUnit ?? null,
    record.usageUnit ?? null,
    record.usageTotal ?? null,
    record.usageDailyRate ?? null,
    JSON.stringify(record.receiptAssetIds ?? []),
    timestamp,
    auth.user.id,
    recordId,
  ).run();
  return successJson(billingRecordPayloadSchema.parse({ record }));
}

/**
 * 生成记录 UPSERT 语句列表；幂等键 (user_id, subscription_id, billing_date, mode) 允许失败重放。
 *
 * DO UPDATE 不改 id/created_at/user_id/subscription_id/billing_date/mode，保持事实行的归属与来源稳定。
 */
export function buildBillingRecordUpsertStatements(env: Env, rows: BillingRecordRow[]): D1PreparedStatement[] {
  return rows.map((row) => env.DB.prepare(`
    INSERT INTO subscription_billing_records (
      id, user_id, subscription_id, name, billing_date, period_end_date, amount, currency,
      billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
      usage_unit, usage_total, usage_daily_rate, mode, receipt_asset_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, subscription_id, billing_date, mode) DO UPDATE SET
      name = excluded.name,
      period_end_date = excluded.period_end_date,
      amount = excluded.amount,
      currency = excluded.currency,
      billing_cycle = excluded.billing_cycle,
      custom_days = excluded.custom_days,
      custom_cycle_unit = excluded.custom_cycle_unit,
      one_time_term_count = excluded.one_time_term_count,
      one_time_term_unit = excluded.one_time_term_unit,
      usage_unit = excluded.usage_unit,
      usage_total = excluded.usage_total,
      usage_daily_rate = excluded.usage_daily_rate,
      receipt_asset_ids = excluded.receipt_asset_ids,
      updated_at = excluded.updated_at
  `).bind(
    row.id,
    row.user_id,
    row.subscription_id,
    row.name,
    row.billing_date,
    row.period_end_date,
    row.amount,
    row.currency,
    row.billing_cycle,
    row.custom_days,
    row.custom_cycle_unit,
    row.one_time_term_count,
    row.one_time_term_unit,
    row.usage_unit,
    row.usage_total,
    row.usage_daily_rate,
    row.mode,
    row.receipt_asset_ids,
    row.created_at,
    row.updated_at,
  ));
}

/** 创建订阅 → mode=initial：billing_date 取 start_date ?? next_billing_date，period_end_date 快照当前续订边界。 */
export function initialBillingRecordRow(subscription: SubscriptionRow, timestamp: string, recordId: string): BillingRecordRow {
  return billingRecordRowFromSnapshot(subscription, {
    id: recordId,
    mode: "initial",
    billingDate: subscription.start_date ?? subscription.next_billing_date,
    periodEndDate: subscription.next_billing_date,
    amount: subscription.price,
    currency: subscription.currency,
  }, timestamp);
}

/** 手动续订 → mode=manual_continue/manual_restart：continue 覆盖旧账单日，restart 从新购买日重开。 */
export function manualRenewBillingRecordRow(
  existing: SubscriptionRow,
  merged: SubscriptionRow,
  body: { mode: "continue" | "restart"; price: string; currency: string; startDate?: string | null | undefined; receiptAssetIds?: string[] | undefined },
  timestamp: string,
  recordId: string,
): BillingRecordRow {
  return billingRecordRowFromSnapshot(merged, {
    id: recordId,
    mode: body.mode === "restart" ? "manual_restart" : "manual_continue",
    receiptAssetIds: body.receiptAssetIds ? JSON.stringify(body.receiptAssetIds) : undefined,
    // restart 的扣费日是用户选择的新购买日；continue 覆盖的是续订前已经落账的旧账单日。
    // 上游 renewSubscriptionRow 已拒绝缺少 startDate 的 restart，末级兜底只为满足类型不变式。
    billingDate: body.mode === "restart" ? body.startDate ?? merged.start_date ?? existing.next_billing_date : existing.next_billing_date,
    periodEndDate: merged.next_billing_date,
    amount: body.price,
    currency: body.currency,
  }, timestamp);
}

/**
 * 自动续订按覆盖的每一期逐条生成：从旧 next_billing_date 逐期推进到新 next_billing_date。
 *
 * usage-based 量包没有可自动推进的周期（上游已排除），这里保持双保险直接不生成记录。
 */
export function autoRenewBillingRecordRows(
  before: SubscriptionRow,
  result: SubscriptionRenewalResult,
  timestamp: string,
  newRecordId: () => string = () => newId(BILLING_RECORD_ID_PREFIX),
): BillingRecordRow[] {
  if (before.billing_cycle === "usage-based") return [];
  const rows: BillingRecordRow[] = [];
  let cursor = before.next_billing_date;
  for (let iterations = 0; cursor < result.nextBillingDate; iterations += 1) {
    if (iterations >= MAX_AUTO_RECORD_CYCLES) {
      // 保护异常周期或脏数据，避免维护任务在单条订阅上无限循环占满 Worker cron。
      throw new Error("SUBSCRIPTION_RENEWAL_ADVANCE_LIMIT_EXCEEDED");
    }
    const periodEndDate = addBillingCycles(
      cursor,
      before.billing_cycle as BillingCycle,
      1,
      before.custom_days,
      before.custom_cycle_unit,
    );
    rows.push(billingRecordRowFromSnapshot(before, {
      id: newRecordId(),
      mode: "auto",
      billingDate: cursor,
      periodEndDate,
      amount: before.price,
      currency: before.currency,
    }, timestamp));
    cursor = periodEndDate;
  }
  return rows;
}

/** 记录快照列从订阅行复制；金额与币种取生成时的真实交易值，不回读订阅当前价。 */
function billingRecordRowFromSnapshot(
  source: SubscriptionRow,
  spec: {
    id: string;
    mode: BillingRecordMode;
    billingDate: string;
    periodEndDate: string | null;
    amount: string;
    currency: string;
    receiptAssetIds?: string;
  },
  timestamp: string,
): BillingRecordRow {
  return {
    id: spec.id,
    user_id: source.user_id,
    subscription_id: source.id,
    name: source.name,
    billing_date: spec.billingDate,
    period_end_date: spec.periodEndDate,
    amount: spec.amount,
    currency: spec.currency,
    billing_cycle: source.billing_cycle,
    custom_days: source.custom_days,
    custom_cycle_unit: source.custom_cycle_unit,
    one_time_term_count: source.one_time_term_count,
    one_time_term_unit: source.one_time_term_unit,
    usage_unit: source.usage_unit,
    usage_total: source.usage_total,
    usage_daily_rate: source.usage_daily_rate,
    mode: spec.mode,
    receipt_asset_ids: spec.receiptAssetIds ?? "[]",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** 合并 PATCH（undefined 保留原值）得到候选记录；D1 snake_case 与历史脏类型在这里收敛回 shared 形状。 */
function billingRecordPatchCandidate(
  row: BillingRecordRow,
  patch: BillingRecordPatchBody,
  timestamp: string,
): {
  id: string;
  subscriptionId: string;
  name: string;
  billingDate: string;
  periodEndDate: string | null;
  amount: string;
  currency: string;
  mode: BillingRecordMode;
  billingCycle: BillingCycle;
  customDays: number | null;
  customCycleUnit: CustomCycleUnit | null;
  oneTimeTermCount: number | null;
  oneTimeTermUnit: CustomCycleUnit | null;
  usageUnit: string | null;
  usageTotal: number | null;
  usageDailyRate: number | null;
  receiptAssetIds: string[];
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    name: row.name,
    billingDate: patch.billingDate ?? row.billing_date,
    periodEndDate: row.period_end_date,
    amount: patch.amount ?? row.amount,
    currency: patch.currency ?? row.currency,
    mode: row.mode as BillingRecordMode,
    billingCycle: patch.billingCycle ?? row.billing_cycle as BillingCycle,
    customDays: patch.customDays !== undefined ? patch.customDays : row.custom_days,
    customCycleUnit: patch.customCycleUnit !== undefined ? patch.customCycleUnit : row.custom_cycle_unit as CustomCycleUnit | null,
    oneTimeTermCount: patch.oneTimeTermCount !== undefined ? patch.oneTimeTermCount : row.one_time_term_count,
    oneTimeTermUnit: patch.oneTimeTermUnit !== undefined ? patch.oneTimeTermUnit : row.one_time_term_unit as CustomCycleUnit | null,
    usageUnit: patch.usageUnit !== undefined ? patch.usageUnit : row.usage_unit,
    usageTotal: patch.usageTotal !== undefined ? patch.usageTotal : row.usage_total,
    usageDailyRate: patch.usageDailyRate !== undefined ? patch.usageDailyRate : row.usage_daily_rate,
    receiptAssetIds: patch.receiptAssetIds !== undefined ? patch.receiptAssetIds : parseReceiptAssetIds(row.receipt_asset_ids),
    createdAt: row.created_at,
    updatedAt: timestamp,
  };
}

/** 列表 query 只挑 limit/cursor；其余交给 shared strict schema 决定默认值与边界。 */
function listQueryInput(params: URLSearchParams): Record<string, string> {
  const input: Record<string, string> = {};
  const limit = params.get("limit");
  const cursor = params.get("cursor");
  if (limit !== null) input["limit"] = limit;
  if (cursor !== null) input["cursor"] = cursor;
  return input;
}
