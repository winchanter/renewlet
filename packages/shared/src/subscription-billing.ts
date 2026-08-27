import type { BillingCycle, CustomCycleUnit, DateOnly } from "./runtime";
import { divideMoney, moneyToNumber, multiplyMoneyRatio, type MoneyString } from "./money";
import {
  addBillingCycles,
  calculateNextBillingDate as calculateRenewalNextBillingDate,
  calculateUsageExhaustionDate,
  requireCustomBillingCycle,
  usageBasedEstimatedDays,
} from "./subscription-renewal";

const AVERAGE_DAYS_PER_MONTH = 30;

export interface SubscriptionBillingFields {
  billingCycle: BillingCycle;
  customDays?: number | null | undefined;
  customCycleUnit?: CustomCycleUnit | null | undefined;
  oneTimeTermCount?: number | null | undefined;
  oneTimeTermUnit?: CustomCycleUnit | null | undefined;
  usageTotal?: number | null | undefined;
  usageDailyRate?: number | null | undefined;
}

// usage-based 推算函数的事实源在 subscription-renewal；这里 re-export 供统计与表单共用同一实现。
export { calculateUsageExhaustionDate, usageBasedEstimatedDays };

/**
 * 将单次扣费金额折算成月均金额。
 *
 * 汇率换算不是本模块职责；调用方必须先把 amount 统一到目标币种，再做周期折算。
 */
export function toMonthlyAmount(
  amount: MoneyString | number,
  cycle: BillingCycle,
  customDays?: number | null | undefined,
  customCycleUnit?: CustomCycleUnit | null | undefined,
  oneTimeTermCount?: number | null | undefined,
  oneTimeTermUnit?: CustomCycleUnit | null | undefined,
  usageTotal?: number | null | undefined,
  usageDailyRate?: number | null | undefined,
): number {
  switch (cycle) {
    case "weekly":
      return moneyToNumber(multiplyMoneyRatio(amount, 433, 100));
    case "monthly":
      return moneyToNumber(amount);
    case "quarterly":
      return moneyToNumber(divideMoney(amount, 3));
    case "semi-annual":
      return moneyToNumber(divideMoney(amount, 6));
    case "annual":
      return moneyToNumber(divideMoney(amount, 12));
    case "custom": {
      const custom = requireCustomBillingCycle(customDays, customCycleUnit);
      return customCycleToMonthlyAmount(amount, custom.count, custom.unit);
    }
    case "one-time": {
      // one-time 无服务期是买断，不进入月均；固定服务期才把整段预付权益按月摊销。
      if (!oneTimeTermCount) return 0;
      const term = requireCustomBillingCycle(oneTimeTermCount, oneTimeTermUnit);
      return customCycleToMonthlyAmount(amount, term.count, term.unit);
    }
    case "usage-based": {
      // 预付量包按预估可用天数摊销总价，等价于“单价 × 日均 × 30”。
      const days = usageBasedEstimatedDays(usageTotal, usageDailyRate);
      return customCycleToMonthlyAmount(amount, days, "day");
    }
  }
}

export function toSubscriptionMonthlyAmount(amount: MoneyString | number, subscription: SubscriptionBillingFields): number {
  return toMonthlyAmount(
    amount,
    subscription.billingCycle,
    subscription.customDays,
    subscription.customCycleUnit,
    subscription.oneTimeTermCount,
    subscription.oneTimeTermUnit,
    subscription.usageTotal,
    subscription.usageDailyRate,
  );
}

/**
 * 从调用方已经归一化的月均金额派生标准化日均成本。
 *
 * 固定 30 天仅用于跨周期比较；真实结算必须继续使用具体账期与日期规则。
 */
export function toDailyAmountFromMonthly(monthlyAmount: number): number {
  return monthlyAmount / AVERAGE_DAYS_PER_MONTH;
}

function customCycleToMonthlyAmount(amount: MoneyString | number, count: number, unit: CustomCycleUnit): number {
  switch (unit) {
    case "week":
      return moneyToNumber(multiplyMoneyRatio(amount, 433, count * 100));
    case "month":
      return moneyToNumber(divideMoney(amount, count));
    case "year":
      return moneyToNumber(divideMoney(amount, count * 12));
    case "day":
      return moneyToNumber(multiplyMoneyRatio(amount, AVERAGE_DAYS_PER_MONTH, count));
  }
}

export function isOneTimeFixedTerm(subscription: Pick<SubscriptionBillingFields, "billingCycle" | "oneTimeTermCount" | "oneTimeTermUnit">): boolean {
  return subscription.billingCycle === "one-time" && Boolean(subscription.oneTimeTermCount && subscription.oneTimeTermUnit);
}

export function isOneTimeBuyout(subscription: Pick<SubscriptionBillingFields, "billingCycle" | "oneTimeTermCount" | "oneTimeTermUnit">): boolean {
  return subscription.billingCycle === "one-time" && !isOneTimeFixedTerm(subscription);
}

export function calculateNextBillingDate(
  startDate: string,
  cycle: BillingCycle,
  customDays?: number | null | undefined,
  referenceDate?: string | null | undefined,
  customCycleUnit?: CustomCycleUnit | null | undefined,
  usageTotal?: number | null | undefined,
  usageDailyRate?: number | null | undefined,
): DateOnly {
  return calculateRenewalNextBillingDate(startDate, cycle, customDays, referenceDate, customCycleUnit, usageTotal, usageDailyRate);
}

export function calculateOneTimeTermEndDate(
  startDate: string,
  count: number,
  unit: CustomCycleUnit,
): DateOnly {
  return addBillingCycles(startDate, "custom", 1, count, unit);
}
