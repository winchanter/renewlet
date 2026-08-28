/**
 * 首页统计领域模型。
 *
 * 架构位置：
 * - 这里只计算“月均/日均支出、活跃数、提醒窗口内续费/到期、试用数”等首页概要。
 * - 汇率转换函数由 application hook 注入，domain 不关心汇率来源和缓存策略。
 */
import { toDailyAmountFromMonthly, toMonthlyAmount } from "@/lib/subscription-billing";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { DEFAULT_NOTIFICATION_REMINDER_DAYS, type SubscriptionCollectionItem } from "@/types/subscription";
import { getEffectiveSubscriptionStatus, isEffectivelyActiveSubscription } from "./subscription-status";
import { buildUpcomingReminderItems } from "./upcoming-reminders";

interface BuildDashboardStatsInput {
  subscriptions: readonly SubscriptionCollectionItem[];
  defaultCurrency: string;
  convert: (amount: number | string, from: string, to: string) => number;
  notificationReminderDays?: number;
  now?: Date;
  timeZone?: string;
}

/** 构建首页概要统计模型。 */
export function buildDashboardStats({
  subscriptions,
  defaultCurrency,
  convert,
  notificationReminderDays = DEFAULT_NOTIFICATION_REMINDER_DAYS,
  now = new Date(),
  timeZone = "UTC",
}: BuildDashboardStatsInput) {
  const today = todayDateOnlyInTimeZone(now, timeZone);
  // 首页金额和数量使用有效状态，避免旧 active/trial 过期记录继续计入活跃月支出。
  const activeSubscriptions = subscriptions.filter((subscription) => isEffectivelyActiveSubscription(subscription, today));
  const totalMonthly = activeSubscriptions.reduce((sum, subscription) => {
    const amountInDefault = convert(subscription.price, subscription.currency, defaultCurrency);
    return sum + toMonthlyAmount(
      amountInDefault,
      subscription.billingCycle,
      subscription.customDays,
      subscription.customCycleUnit,
      subscription.oneTimeTermCount,
      subscription.oneTimeTermUnit,
      subscription.usageTotal,
      subscription.usageDailyRate,
    );
  }, 0);
  const totalDaily = toDailyAmountFromMonthly(totalMonthly);
  const upcomingCount = buildUpcomingReminderItems({ subscriptions, notificationReminderDays, now, timeZone }).length;
  // 试用数量也按有效状态统计：过期 trial 应归入 expired，而不是继续提醒用户关注转付费。
  const trialCount = subscriptions.filter((subscription) => getEffectiveSubscriptionStatus(subscription, today) === "trial").length;

  return {
    activeSubscriptions,
    totalMonthly,
    totalDaily,
    upcomingCount,
    trialCount,
  };
}
