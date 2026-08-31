import { z } from "zod";
import { moneyStringSchema } from "../money";
import { addBillingCycles, calculateUsageBoundaryDate } from "../subscription-renewal";
import { apiSuccessResponseSchema } from "./api";
import {
  BILLING_CYCLES,
  BILLING_RECORD_MODES,
  CUSTOM_CYCLE_UNITS,
  RECEIPT_ASSET_IDS_MAX,
  isValidDateOnly,
  type BillingCycle,
  type CustomCycleUnit,
  type DateOnly,
} from "../runtime";
import {
  dateInputSchema,
  oneTimeTermCountSchema,
  oneTimeTermUnitSchema,
  usageDailyRateSchema,
  usageExpiresAtSchema,
  usageRemainingBeforeSchema,
  usageTotalSchema,
  usageUnitSchema,
} from "./subscriptions";

/**
 * 扣费记录 API schema 是 Docker Go、Cloudflare Worker 和前端历史面板的共享边界。
 *
 * 记录是订阅每期扣费的事实快照：生成时从订阅复制字段，之后独立演化，不与订阅联动回写。
 * 归属（subscriptionId）与来源（mode、name 快照）不可改；PATCH 只开放事实修正字段。
 * 任何字段变化都必须同步 PocketBase collection、D1 migration 和前端 domain 类型。
 */
export const BILLING_RECORD_QUERY_DEFAULT_LIMIT = 50;

const BILLING_RECORD_CURSOR_SEPARATOR = "~";

const billingRecordCycleShape = {
  billingCycle: z.enum(BILLING_CYCLES),
  customDays: z.number().int().positive().nullable().optional(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable().optional(),
  oneTimeTermCount: oneTimeTermCountSchema.nullable().optional(),
  oneTimeTermUnit: oneTimeTermUnitSchema.nullable().optional(),
  usageUnit: usageUnitSchema.nullable().optional(),
  usageTotal: usageTotalSchema.nullable().optional(),
  usageDailyRate: usageDailyRateSchema.nullable().optional(),
  // usage-based 扣费记录的余量/失效快照：usageTotal 是本次实际购买量，
  // usageRemainingBefore 是本次扣费期开始前结转的旧包余量，两者之和 = 购买后订阅持有量。
  usageRemainingBefore: usageRemainingBeforeSchema,
  usageExpiresAt: usageExpiresAtSchema,
} satisfies z.ZodRawShape;

/** 记录快照沿用订阅写入边界的互斥规则；不允许出现订阅不可能拥有的周期字段组合。 */
export function billingRecordCycleIsConsistent(value: {
  billingCycle: BillingCycle;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
  oneTimeTermCount?: number | null | undefined;
  oneTimeTermUnit?: CustomCycleUnit | null | undefined;
  usageUnit?: string | null | undefined;
  usageTotal?: number | null | undefined;
  usageDailyRate?: number | null | undefined;
  usageRemainingBefore?: number | null | undefined;
  usageExpiresAt?: string | null | undefined;
}): boolean {
  if (value.billingCycle === "custom") {
    return typeof value.customDays === "number" && value.customDays > 0
      && value.customCycleUnit !== null && value.customCycleUnit !== undefined
      && value.oneTimeTermCount == null && value.oneTimeTermUnit == null
      && value.usageUnit == null && value.usageTotal == null && value.usageDailyRate == null
      && value.usageRemainingBefore == null && value.usageExpiresAt == null;
  }
  if (value.billingCycle === "one-time") {
    return (value.oneTimeTermCount != null) === (value.oneTimeTermUnit != null)
      && value.customDays == null && value.customCycleUnit == null
      && value.usageUnit == null && value.usageTotal == null && value.usageDailyRate == null
      && value.usageRemainingBefore == null && value.usageExpiresAt == null;
  }
  if (value.billingCycle === "usage-based") {
    return value.usageUnit != null && value.usageTotal != null && value.usageDailyRate != null
      && value.customDays == null && value.customCycleUnit == null
      && value.oneTimeTermCount == null && value.oneTimeTermUnit == null;
  }
  return value.customDays == null && value.customCycleUnit == null
    && value.oneTimeTermCount == null && value.oneTimeTermUnit == null
    && value.usageUnit == null && value.usageTotal == null && value.usageDailyRate == null
    && value.usageRemainingBefore == null && value.usageExpiresAt == null;
}

const billingRecordShape = {
  id: z.string().min(1),
  subscriptionId: z.string().min(1),
  // name 是订阅名称快照：订阅删除后仍是历史行的展示兜底，因此不随订阅改名联动。
  name: z.string().min(1).max(120),
  billingDate: dateInputSchema,
  // 本期覆盖的到期日快照：生成时取自真实续订计算结果；one-time 买断为 null。
  periodEndDate: dateInputSchema.nullable(),
  amount: moneyStringSchema,
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  mode: z.enum(BILLING_RECORD_MODES),
  // 续订凭证（截图/发票）的 asset ID 列表；旧记录无此字段时默认空数组。
  receiptAssetIds: z.array(z.string().min(1)).max(RECEIPT_ASSET_IDS_MAX).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  ...billingRecordCycleShape,
} satisfies z.ZodRawShape;

export const apiBillingRecordSchema = z.object(billingRecordShape).strict()
  .refine(billingRecordCycleIsConsistent, {
    path: ["billingCycle"],
    message: "Billing record cycle fields are inconsistent",
  })
  .refine((value) => value.periodEndDate === null || value.periodEndDate >= value.billingDate, {
    path: ["periodEndDate"],
    message: "Period end date must not be before billing date",
  });
export type ApiBillingRecord = z.infer<typeof apiBillingRecordSchema>;

/** PATCH 只允许事实修正；归属与来源字段不在此列，服务端合并后必须通过完整记录 schema 校验。 */
export const billingRecordPatchBodySchema = z.object({
  amount: moneyStringSchema.optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  billingDate: dateInputSchema.optional(),
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  customDays: z.number().int().positive().nullable().optional(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).nullable().optional(),
  oneTimeTermCount: oneTimeTermCountSchema.nullable().optional(),
  oneTimeTermUnit: oneTimeTermUnitSchema.nullable().optional(),
  usageUnit: usageUnitSchema.nullable().optional(),
  usageTotal: usageTotalSchema.nullable().optional(),
  usageDailyRate: usageDailyRateSchema.nullable().optional(),
  usageRemainingBefore: usageRemainingBeforeSchema,
  usageExpiresAt: usageExpiresAtSchema,
  receiptAssetIds: z.array(z.string().min(1)).max(RECEIPT_ASSET_IDS_MAX).optional(),
}).strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Empty payload" });
export type BillingRecordPatchBody = z.infer<typeof billingRecordPatchBodySchema>;

/** 周期影响字段发生变化时必须重算 periodEndDate，避免快照覆盖区间与周期快照互相矛盾。 */
export function billingRecordPatchTouchesPeriod(patch: BillingRecordPatchBody): boolean {
  return patch.billingDate !== undefined
    || patch.billingCycle !== undefined
    || patch.customDays !== undefined
    || patch.customCycleUnit !== undefined
    || patch.usageTotal !== undefined
    || patch.usageDailyRate !== undefined
    || patch.usageRemainingBefore !== undefined
    || patch.usageExpiresAt !== undefined;
}

/**
 * 记录编辑重算到期日：锚点固定为编辑后的扣费日。
 *
 * 生成时的 periodEndDate 用的是真实续订结果（锚点可能取自 startDate）；编辑后无法还原
 * 历史锚点，因此统一按“扣费日 + 一期/预估可用天数”重算，保证快照自洽。
 * usage-based 的持有量 = usageTotal（本次购买量）+ usageRemainingBefore（结转余量），
 * 且到期边界取 min(推算耗尽日, 失效日)，与订阅行的边界口径一致。
 */
export function computeBillingRecordPeriodEnd(record: {
  billingDate: string;
  billingCycle: BillingCycle;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
  usageTotal?: number | null | undefined;
  usageDailyRate?: number | null | undefined;
  usageRemainingBefore?: number | null | undefined;
  usageExpiresAt?: string | null | undefined;
}): DateOnly | null {
  if (record.billingCycle === "one-time") return null;
  if (record.billingCycle === "usage-based") {
    const holdingTotal = (record.usageTotal ?? 0) + (record.usageRemainingBefore ?? 0);
    return calculateUsageBoundaryDate(record.billingDate, holdingTotal, record.usageDailyRate ?? 0, record.usageExpiresAt);
  }
  return addBillingCycles(record.billingDate, record.billingCycle, 1, record.customDays, record.customCycleUnit);
}

export const billingRecordsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(BILLING_RECORD_QUERY_DEFAULT_LIMIT),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();
export type BillingRecordsListQuery = z.infer<typeof billingRecordsListQuerySchema>;

export const billingRecordsListPayloadSchema = z.object({
  records: z.array(apiBillingRecordSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
}).strict();
export const billingRecordsListResponseSchema = apiSuccessResponseSchema(billingRecordsListPayloadSchema);

export const billingRecordPayloadSchema = z.object({
  record: apiBillingRecordSchema,
}).strict();
export const billingRecordResponseSchema = apiSuccessResponseSchema(billingRecordPayloadSchema);

/** 游标 = (billingDate, id) keyset；date-only 定长且 `~` 不会出现在两者中，可安全拼接。 */
export function encodeBillingRecordCursor(record: { billingDate: string; id: string }): string {
  return `${record.billingDate}${BILLING_RECORD_CURSOR_SEPARATOR}${record.id}`;
}

export function decodeBillingRecordCursor(cursor: string): { billingDate: string; id: string } | null {
  const index = cursor.indexOf(BILLING_RECORD_CURSOR_SEPARATOR);
  if (index <= 0) return null;
  const billingDate = cursor.slice(0, index);
  const id = cursor.slice(index + 1);
  if (!isValidDateOnly(billingDate) || !id) return null;
  return { billingDate, id };
}
