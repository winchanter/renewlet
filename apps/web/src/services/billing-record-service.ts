import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { apiFetch } from "@/lib/api-client";
import { assertDateOnly } from "@/lib/time/date-only";
import { getCurrentUserId } from "@/lib/pocketbase";
import {
  BILLING_RECORD_QUERY_DEFAULT_LIMIT,
  billingRecordResponseSchema,
  billingRecordsListResponseSchema,
  type ApiBillingRecord,
  type BillingRecordPatchBody,
} from "@renewlet/shared/schemas/billing-records";

/** 与服务端 query 上限保持一致；分页尺寸只在服务层收敛，UI 不自行拼接参数。 */
const BILLING_RECORDS_MAX_LIMIT = 100;

export interface BillingRecordsPage {
  records: ApiBillingRecord[];
  nextCursor: string | null;
  total: number;
}

export interface ListBillingRecordsOptions {
  limit?: number | undefined;
  cursor?: string | null | undefined;
  signal?: AbortSignal | undefined;
}

function normalizePageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return BILLING_RECORD_QUERY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(value), BILLING_RECORDS_MAX_LIMIT));
}

/** date-only 字段收敛为品牌类型，防止普通字符串绕过日期比较工具的类型边界。 */
function fromApiBillingRecord(record: ApiBillingRecord): ApiBillingRecord {
  return {
    ...record,
    billingDate: assertDateOnly(record.billingDate),
    periodEndDate: record.periodEndDate === null ? null : assertDateOnly(record.periodEndDate),
  };
}

/** 拉取订阅的扣费记录分页；游标为空时从第一页开始。 */
export async function listBillingRecords(
  subscriptionId: string,
  options: ListBillingRecordsOptions = {},
): Promise<BillingRecordsPage> {
  if (!getCurrentUserId()) return { records: [], nextCursor: null, total: 0 };
  const params = new URLSearchParams({ limit: String(normalizePageLimit(options.limit)) });
  if (options.cursor) params.set("cursor", options.cursor);
  const data = await apiFetch(
    `/api/app/subscriptions/${subscriptionId}/billing-records?${params.toString()}`,
    billingRecordsListResponseSchema,
    options.signal ? { signal: options.signal } : undefined,
  );
  return {
    records: data.records.map(fromApiBillingRecord),
    nextCursor: data.nextCursor,
    total: data.total,
  };
}

/** 修正单条扣费记录；服务端合并补丁并重算账期后返回完整记录。 */
export async function updateBillingRecord(
  recordId: string,
  patch: BillingRecordPatchBody,
  signal?: AbortSignal,
): Promise<ApiBillingRecord> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch(`/api/app/billing-records/${recordId}`, billingRecordResponseSchema, {
    method: "PATCH",
    body: JSON.stringify(patch),
    ...(signal ? { signal } : undefined),
  });
  return fromApiBillingRecord(data.record);
}
