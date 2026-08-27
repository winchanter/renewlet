/**
 * 即将续费/到期列表（首页主区域卡片）。
 *
 * 规则：
 * - 只展示提醒窗口内的 active/trial
 * - 展示续费或一次性固定服务期到期
 * - 最多展示 5 条
 * - 移动端单列，sm 起两列，xl 起三列，保持首页满宽时的视觉密度
 */

import type { SubscriptionCollectionItem } from '@/types/subscription';
import { cn } from '@/lib/utils';
import { formatDateOnlyMonthDay } from '@/lib/time/date-only';
import { useI18n } from '@/i18n/I18nProvider';
import { buildUpcomingReminderItems } from '@/modules/subscriptions/domain/upcoming-reminders';

interface UpcomingRenewalsProps {
  /** 订阅列表（前端 domain 类型）。 */
  subscriptions: SubscriptionCollectionItem[];
  /** 用户 IANA 时区，用于计算本地“今天”。 */
  timeZone: string;
  /** 设置页默认提前提醒天数，用于解析继承型订阅。 */
  notificationReminderDays: number;
  /**
   * 行主体 primary action：打开只读详情对话框；与订阅卡片保持一致的交互。
   * 未传时整行不可点击（如测试用例或详情页复用场景）。
   */
  onViewDetails?: (id: string) => void;
}

/** 即将续费列表组件。 */
export function UpcomingRenewals({ subscriptions, timeZone, notificationReminderDays, onViewDetails }: UpcomingRenewalsProps) {
  const { t, formatCurrency, locale } = useI18n();
  const upcoming = buildUpcomingReminderItems({ subscriptions, timeZone, notificationReminderDays }).slice(0, 5);

  if (upcoming.length === 0) {
    return (
      <p className="py-4 text-center text-sm leading-6 text-muted-foreground">{t("upcoming.noneNextTwoWeeks")}</p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {upcoming.map((item) => {
        const subscriptionId = item.subscription.id;
        const subscriptionName = item.subscription.name;
        return (
          <div
            key={subscriptionId}
            className={cn(
              "relative flex items-center justify-between rounded-lg border border-border bg-secondary/50 p-4 transition-colors hover:bg-secondary",
              item.daysUntil <= 3 && "border-warning/30 bg-warning/5"
            )}
          >
            {onViewDetails ? (
              <button
                type="button"
                aria-label={t("subscription.viewDetailsLabel", { name: subscriptionName })}
                className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={() => onViewDetails(subscriptionId)}
                data-testid="upcoming-row-primary-action"
              />
            ) : null}
            <div className={cn("relative z-10 flex w-full items-center justify-between gap-3", onViewDetails && "pointer-events-none")}>
              <div className="flex items-center gap-3">
                <div className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold",
                  item.daysUntil <= 3
                    ? "bg-warning/20 text-warning"
                    : "bg-muted text-muted-foreground"
                )}>
                  {item.daysUntil === 0 ? t("upcoming.todayShort") : t("upcoming.daysShort", { days: item.daysUntil })}
                </div>
                <div>
                  <p className="font-medium text-foreground">{subscriptionName}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.kind === "expiry"
                      ? t("upcoming.expiresOn", { date: formatDateOnlyMonthDay(item.subscription.nextBillingDate, locale) })
                      : t("upcoming.renewsOn", { date: formatDateOnlyMonthDay(item.subscription.nextBillingDate, locale) })}
                  </p>
                </div>
              </div>
              <p className="font-semibold text-foreground shrink-0">
                {formatCurrency(item.subscription.price, item.subscription.currency)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
