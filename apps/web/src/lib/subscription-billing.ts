/**
 * 订阅账单周期计算工具。
 *
 * 架构位置：
 * - 表单自动计算下次扣费日。
 * - 仪表盘/统计页把不同周期统一折算到月度口径。
 *
 * 注意： 这里不做汇率换算；金额币种归一化由统计模型处理。
 */
import type { BillingCycle, CustomCycleUnit } from "@/types/subscription";
import type { DateOnly } from "@/lib/time/date-only";
import { localizedLabel, type Locale } from "@/i18n/locales";
import { translate } from "@/i18n/messages";
import { CYCLE_LABELS } from "@/types/subscription";
import {
  calculateNextBillingDate as calculateSharedNextBillingDate,
  calculateOneTimeTermEndDate as calculateSharedOneTimeTermEndDate,
  calculateUsageExhaustionDate as calculateSharedUsageExhaustionDate,
  isOneTimeBuyout,
  isOneTimeFixedTerm,
  toDailyAmountFromMonthly,
  toMonthlyAmount,
  toSubscriptionMonthlyAmount,
  usageBasedEstimatedDays,
} from "@renewlet/shared/subscription-billing";
import { requireCustomBillingCycle } from "@renewlet/shared/subscription-renewal";

export {
  isOneTimeBuyout,
  isOneTimeFixedTerm,
  toDailyAmountFromMonthly,
  toMonthlyAmount,
  toSubscriptionMonthlyAmount,
  usageBasedEstimatedDays,
};

/**
 * 根据开始日期 + 周期计算“下一次扣费日期”。
 *
 * 规则：
 * - 未传 referenceDate 时，从 startDate 起加一个扣费周期，得到当前订阅周期的到期/下次扣费日期
 * - 传入 referenceDate 时，按 startDate 锚定周期，返回 referenceDate 当天或之后最近一次扣费日
 * - 自定义周期（custom）必须显式提供 customDays + customCycleUnit
 * - 一次性购买（one-time）不产生下一次扣费，防御性返回开始日
 *
 * 注意：
 * - 这是纯函数：不会修改传入的 Date 对象
 * - UI 侧（新增/编辑订阅）都依赖该计算逻辑，集中到一个文件便于统一维护
 */
export function calculateNextBillingDate(
  startDate: DateOnly,
  cycle: BillingCycle,
  customDays?: number,
  referenceDate?: DateOnly,
  customCycleUnit?: CustomCycleUnit,
): DateOnly {
  return calculateSharedNextBillingDate(startDate, cycle, customDays, referenceDate, customCycleUnit) as DateOnly;
}

export function calculateOneTimeTermEndDate(
  startDate: DateOnly,
  count: number,
  unit: CustomCycleUnit,
): DateOnly {
  return calculateSharedOneTimeTermEndDate(startDate, count, unit) as DateOnly;
}

/** 预付量包的预计耗尽日 = 购买日 + ceil(总量/日均)，作为 nextBillingDate 驱动到期提醒。 */
export function calculateUsageExhaustionDate(
  startDate: DateOnly,
  usageTotal: number,
  usageDailyRate: number,
): DateOnly {
  return calculateSharedUsageExhaustionDate(startDate, usageTotal, usageDailyRate) as DateOnly;
}

export function customCycleUnitLabelKey(unit: CustomCycleUnit): `subscription.customCycleUnit.${CustomCycleUnit}` {
  return `subscription.customCycleUnit.${unit}`;
}

export function formatBillingCycleLabel(subscription: { billingCycle: BillingCycle; customDays?: number | undefined; customCycleUnit?: CustomCycleUnit | undefined }, locale: Locale): string {
  if (subscription.billingCycle !== "custom") {
    return localizedLabel(CYCLE_LABELS[subscription.billingCycle], locale);
  }
  const custom = requireCustomBillingCycle(subscription.customDays, subscription.customCycleUnit);
  const unitLabel = translate(locale, customCycleUnitLabelKey(custom.unit));
  return translate(locale, "subscription.customCycleLabel", { count: custom.count, unit: unitLabel });
}
