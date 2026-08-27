import {
  SUBSCRIPTION_PAYMENT_METHOD_NONE,
  type SubscriptionsListQuery,
} from "@renewlet/shared/schemas/subscriptions";
import { DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS } from "@renewlet/shared/runtime";
import {
  SUBSCRIPTION_COLLECTION_COLUMN_NAMES,
  listSubscriptionCollectionPage,
  parseSubscriptionCursor,
} from "./db";
import { getSubscriptionTotal } from "./subscription-derived-state";
import type { Env, SubscriptionCollectionRow } from "./types";

const SUBSCRIPTION_COLLECTION_COLUMNS_FROM_FACT = SUBSCRIPTION_COLLECTION_COLUMN_NAMES
  .map((column) => `sub.${column}`)
  .join(", ");

export type SubscriptionCollectionFilters = Omit<SubscriptionsListQuery, "cursor" | "limit">;

export interface SubscriptionSqlQueryPlan {
  sql: string;
  params: unknown[];
}

export interface SubscriptionCollectionQueryPlan {
  count: SubscriptionSqlQueryPlan;
  facts: SubscriptionSqlQueryPlan;
}

/**
 * 订阅筛选保留 exact total：筛选条件只作用于轻量投影，事实表 JOIN 也只读取集合 DTO 所需列。
 *
 * cursor 只能影响本页起点，不能进入 total 口径；否则筛选页顶部统计会随滚动递减。
 */
export async function listSubscriptionsForQuery(
  env: Env,
  userId: string,
  query: SubscriptionsListQuery,
  today: string,
): Promise<{ rows: SubscriptionCollectionRow[]; total: number }> {
  if (!subscriptionListQueryHasFilters(query)) {
    // 两个读取互不依赖；并发执行避免无筛选首页形成固定 D1 waterfall。
    const [rows, total] = await Promise.all([
      listSubscriptionCollectionPage(env, userId, { limit: query.limit + 1, cursor: query.cursor }),
      getSubscriptionTotal(env, userId),
    ]);
    return { rows, total };
  }
  return await collectFilteredSubscriptions(env, userId, query, today);
}

/** 完整集合先在投影层确认上限，再读取轻量事实列；超限请求不会触碰 subscriptions facts。 */
export async function listBoundedSubscriptionsForQuery(
  env: Env,
  userId: string,
  query: SubscriptionCollectionFilters,
  today: string,
  maxItems: number,
): Promise<{ rows: SubscriptionCollectionRow[]; total: number; exceeded: boolean }> {
  const plan = subscriptionCollectionQueryPlan(userId, query, today, maxItems + 1);
  const total = await countSubscriptionProjection(env, plan.count);
  if (total > maxItems) return { rows: [], total, exceeded: true };

  // count 与读取之间若发生并发写入，额外一行仍会把请求收敛为 422，不能返回伪完整集合。
  const rows = await readSubscriptionCollectionFacts(env, plan.facts);
  if (rows.length > maxItems) return { rows: [], total: rows.length, exceeded: true };
  // 成功响应以事实行数为 total，避免 count 后并发删除留下与返回数组不一致的元数据。
  return { rows, total: rows.length, exceeded: false };
}

async function collectFilteredSubscriptions(env: Env, userId: string, query: SubscriptionsListQuery, today: string): Promise<{ rows: SubscriptionCollectionRow[]; total: number }> {
  const cursor = parseSubscriptionCursor(query.cursor);
  const plan = subscriptionCollectionQueryPlan(userId, query, today, query.limit + 1, cursor);
  // count 不带业务 cursor，保证 total 描述完整过滤集；事实表 JOIN 避免先收集数千 ID 再构造超大 IN。
  const [total, rows] = await Promise.all([
    countSubscriptionProjection(env, plan.count),
    readSubscriptionCollectionFacts(env, plan.facts),
  ]);
  return { rows, total };
}

type SubscriptionProjectionQuery = { where: string; params: unknown[] };

export function subscriptionCollectionQueryPlan(
  userId: string,
  query: SubscriptionCollectionFilters,
  today: string,
  limit: number,
  cursor?: { createdAt: string; id: string } | null,
): SubscriptionCollectionQueryPlan {
  const base = subscriptionListBaseQuery(userId, query, today);
  const cursorCondition = cursor ? "AND (idx.created_at < ? OR (idx.created_at = ? AND idx.subscription_id < ?))" : "";
  const cursorParams = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  return {
    count: {
      sql: `SELECT COUNT(*) AS total FROM subscription_list_index AS idx WHERE ${base.where}`,
      params: base.params,
    },
    facts: {
      sql: `
        SELECT ${SUBSCRIPTION_COLLECTION_COLUMNS_FROM_FACT}
        FROM subscription_list_index AS idx
        INNER JOIN subscriptions AS sub ON sub.user_id = idx.user_id AND sub.id = idx.subscription_id
        WHERE ${base.where} ${cursorCondition}
        ORDER BY idx.created_at DESC, idx.subscription_id DESC
        LIMIT ?
      `,
      params: [...base.params, ...cursorParams, limit],
    },
  };
}

async function countSubscriptionProjection(env: Env, plan: SubscriptionSqlQueryPlan): Promise<number> {
  const row = await env.DB.prepare(plan.sql)
    .bind(...plan.params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function readSubscriptionCollectionFacts(
  env: Env,
  plan: SubscriptionSqlQueryPlan,
): Promise<SubscriptionCollectionRow[]> {
  const page = await env.DB.prepare(plan.sql).bind(...plan.params).all<SubscriptionCollectionRow>();
  return page.results;
}

function subscriptionListBaseQuery(
  userId: string,
  query: SubscriptionCollectionFilters,
  today: string,
): { where: string; params: unknown[] } {
  // 所有筛选都在 owner-scoped 投影中完成；事实表 JOIN 只负责返回规范化 DTO 所需字段。
  const conditions = ["idx.user_id = ?"];
  const params: unknown[] = [userId];
  appendSqlInCondition(conditions, params, "idx.category", query.category);
  appendSqlInCondition(conditions, params, "idx.billing_cycle", query.billingCycle);
  appendSqlInCondition(conditions, params, "idx.currency", query.currency);
  appendPaymentMethodCondition(conditions, params, query.paymentMethod);
  appendRenewalCondition(conditions, query.renewal);
  appendTagCondition(conditions, params, query.tag);
  if (query.nextBillingFrom) {
    conditions.push("idx.next_billing_date >= ?");
    params.push(query.nextBillingFrom);
  }
  if (query.nextBillingTo) {
    conditions.push("idx.next_billing_date <= ?");
    params.push(query.nextBillingTo);
  }
  if (query.pinned !== undefined) {
    conditions.push("idx.pinned = ?");
    params.push(query.pinned ? 1 : 0);
  }
  if (query.publicHidden !== undefined) {
    conditions.push("idx.public_hidden = ?");
    params.push(query.publicHidden ? 1 : 0);
  }
  appendReminderModeCondition(conditions, params, query.reminderMode);
  if (query.repeatReminder !== undefined) {
    conditions.push("idx.repeat_reminder_enabled = ?");
    params.push(query.repeatReminder ? 1 : 0);
  }
  if (query.q) {
    conditions.push("instr(idx.search_text_lower, ?) > 0");
    params.push(query.q.trim().toLowerCase());
  }
  if (query.status) {
    conditions.push(`(CASE
      WHEN idx.status = 'expired' THEN 'expired'
      WHEN idx.billing_cycle = 'one-time' AND COALESCE(idx.one_time_term_count, 0) <= 0 THEN idx.status
      WHEN idx.status IN ('active', 'trial') AND idx.next_billing_date < ? THEN 'expired'
      ELSE idx.status
    END) = ?`);
    params.push(today, query.status);
  }
  return { where: conditions.join(" AND "), params };
}

function appendSqlInCondition(conditions: string[], params: unknown[], column: string, values: readonly string[] | undefined): void {
  if (!values?.length) return;
  conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}

function appendPaymentMethodCondition(conditions: string[], params: unknown[], values: readonly string[] | undefined): void {
  if (!values?.length) return;
  const concrete = values.filter((value) => value !== SUBSCRIPTION_PAYMENT_METHOD_NONE);
  const parts: string[] = [];
  if (values.includes(SUBSCRIPTION_PAYMENT_METHOD_NONE)) parts.push("(idx.payment_method IS NULL OR idx.payment_method = '')");
  if (concrete.length > 0) {
    parts.push(`idx.payment_method IN (${concrete.map(() => "?").join(", ")})`);
    params.push(...concrete);
  }
  conditions.push(`(${parts.join(" OR ")})`);
}

function appendRenewalCondition(conditions: string[], renewal: SubscriptionsListQuery["renewal"]): void {
  switch (renewal) {
    case "auto":
      conditions.push("idx.billing_cycle NOT IN ('one-time', 'usage-based') AND idx.auto_renew = 1");
      break;
    case "manual":
      conditions.push("idx.billing_cycle NOT IN ('one-time', 'usage-based') AND idx.auto_renew = 0");
      break;
    case "one-time":
      // 一次性购买包含买断与预付量包；两者都没有自动推进的扣费周期。
      conditions.push("idx.billing_cycle IN ('one-time', 'usage-based')");
      break;
  }
}

function appendTagCondition(conditions: string[], params: unknown[], values: readonly string[] | undefined): void {
  const tags = values?.filter((value) => value.trim() !== "") ?? [];
  if (tags.length === 0) return;
  // tag_norm 用来命中索引，tag 原文用来保留旧 JSON tags.includes 的大小写敏感语义。
  conditions.push(`
    EXISTS (
      SELECT 1 FROM subscription_tags AS tag
      WHERE tag.user_id = idx.user_id
        AND tag.subscription_id = idx.subscription_id
        AND (${tags.map(() => "(tag.tag_norm = ? AND tag.tag = ?)").join(" OR ")})
    )
  `);
  params.push(...tags.flatMap((tag) => [tag.trim().toLowerCase(), tag]));
}

function appendReminderModeCondition(
  conditions: string[],
  params: unknown[],
  mode: SubscriptionsListQuery["reminderMode"],
): void {
  switch (mode) {
    case "disabled":
      conditions.push("idx.reminder_days = ?");
      params.push(DISABLED_REMINDER_DAYS);
      break;
    case "inherit":
      conditions.push("idx.reminder_days = ?");
      params.push(INHERIT_REMINDER_DAYS);
      break;
    case "custom":
      conditions.push("idx.reminder_days >= 0");
      break;
  }
}

function subscriptionListQueryHasFilters(query: SubscriptionCollectionFilters): boolean {
  return Boolean(
    query.q ||
    query.category?.length ||
    query.tag?.length ||
    query.billingCycle?.length ||
    query.paymentMethod?.length ||
    query.currency?.length ||
    query.status ||
    query.renewal ||
    query.nextBillingFrom ||
    query.nextBillingTo ||
    query.pinned !== undefined ||
    query.publicHidden !== undefined ||
    query.reminderMode ||
    query.repeatReminder !== undefined,
  );
}
