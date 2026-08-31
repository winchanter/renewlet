/**
 * 订阅分组视图。
 *
 * 架构位置：订阅列表页的分组视图模式，与 SubscriptionGrid（平铺虚拟列表）并列。
 * 按订阅组折叠展示：组头（logo + 名称 + 订阅数 + 月均支出）可展开/收起，
 * 展开后以卡片网格渲染组内订阅；未分组订阅单独成区。
 *
 * 不使用虚拟化：组内订阅数量通常较小，虚拟化多实例会与根滚动监听冲突。
 */
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { SubscriptionCard, type SubscriptionCardLookup } from "@/components/subscription-card";
import { SubscriptionLogo } from "@/components/subscription-logo";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import { toMonthlyAmount } from "@/lib/subscription-billing";
import { useI18n } from "@/i18n/I18nProvider";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import type { SubscriptionGroup } from "@renewlet/shared/schemas/subscription-groups";
import type { SubscriptionCurrencyConverter } from "@/modules/subscriptions/domain/subscription-price-reference";

interface SubscriptionGroupedViewProps {
  subscriptions: SubscriptionCollectionItem[];
  groups: SubscriptionGroup[];
  viewMode: "grid" | "list";
  timeZone: string;
  inheritedReminderDays: number;
  currencyConvert: SubscriptionCurrencyConverter;
  currencyRatesReady: boolean;
  priceReferenceCurrency: string | null;
  defaultCurrency: string;
  categoryByValue: SubscriptionCardLookup;
  paymentMethodByValue: SubscriptionCardLookup;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onClone: (id: string) => void;
  onTogglePinned: (id: string) => void;
  onTogglePublicHidden: (id: string) => void;
  onRenew: (id: string) => void;
  onViewBillingRecords: (id: string) => void;
  onViewDetails: (id: string) => void;
  onAddToCalendar: (id: string) => void;
  onPrefetchDetails: (id: string) => void;
}

interface GroupBucket {
  group: SubscriptionGroup;
  items: SubscriptionCollectionItem[];
  totalMonthly: number;
}

function calculateMonthlyTotal(
  items: SubscriptionCollectionItem[],
  defaultCurrency: string,
  convert: SubscriptionCurrencyConverter,
): number {
  return items.reduce((sum, subscription) => {
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
}

export function SubscriptionGroupedView({
  subscriptions,
  groups,
  viewMode,
  timeZone,
  inheritedReminderDays,
  currencyConvert,
  currencyRatesReady,
  priceReferenceCurrency,
  defaultCurrency,
  categoryByValue,
  paymentMethodByValue,
  onEdit,
  onDelete,
  onClone,
  onTogglePinned,
  onTogglePublicHidden,
  onRenew,
  onViewBillingRecords,
  onViewDetails,
  onAddToCalendar,
  onPrefetchDetails,
}: SubscriptionGroupedViewProps) {
  const { t, locale } = useI18n();

  // 按组分桶并计算每组月均支出；组顺序沿用 groups 列表的 sortOrder。
  const { groupedBuckets, ungroupedItems, ungroupedMonthly } = useMemo(() => {
    const buckets = new Map<string, SubscriptionCollectionItem[]>();
    const ungrouped: SubscriptionCollectionItem[] = [];
    for (const subscription of subscriptions) {
      const groupId = subscription.groupId;
      if (!groupId) {
        ungrouped.push(subscription);
        continue;
      }
      const bucket = buckets.get(groupId);
      if (bucket) bucket.push(subscription);
      else buckets.set(groupId, [subscription]);
    }
    const grouped: GroupBucket[] = groups
      .filter((group) => buckets.has(group.id))
      .map((group) => {
        const items = buckets.get(group.id)!;
        return {
          group,
          items,
          totalMonthly: calculateMonthlyTotal(items, defaultCurrency, currencyConvert),
        };
      });
    return {
      groupedBuckets: grouped,
      ungroupedItems: ungrouped,
      ungroupedMonthly: calculateMonthlyTotal(ungrouped, defaultCurrency, currencyConvert),
    };
  }, [subscriptions, groups, defaultCurrency, currencyConvert]);

  // 默认展开所有组；用户可手动收起。
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const renderCards = (items: SubscriptionCollectionItem[]) => (
    <div className={cn(
      "grid gap-4",
      viewMode === "list" ? "grid-cols-1" : "sm:grid-cols-2 xl:grid-cols-3",
    )}>
      {items.map((subscription) => (
        <SubscriptionCard
          key={subscription.id}
          subscription={subscription}
          viewMode={viewMode}
          timeZone={timeZone}
          inheritedReminderDays={inheritedReminderDays}
          currencyConvert={currencyConvert}
          currencyRatesReady={currencyRatesReady}
          priceReferenceCurrency={priceReferenceCurrency}
          categoryByValue={categoryByValue}
          paymentMethodByValue={paymentMethodByValue}
          onEdit={onEdit}
          onDelete={onDelete}
          onClone={onClone}
          onTogglePinned={onTogglePinned}
          onTogglePublicHidden={onTogglePublicHidden}
          onRenew={onRenew}
          onViewBillingRecords={onViewBillingRecords}
          onViewDetails={onViewDetails}
          onAddToCalendar={onAddToCalendar}
          onPrefetchDetails={onPrefetchDetails}
        />
      ))}
    </div>
  );

  const renderGroupHeader = (
    name: string,
    logo: string | null | undefined,
    count: number,
    totalMonthly: number,
    isCollapsed: boolean,
  ) => (
    <div className="flex items-center gap-3">
      <ChevronDown
        className={cn(
          "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
          isCollapsed && "-rotate-90",
        )}
      />
      {logo !== null && logo !== undefined ? (
        <SubscriptionLogo name={name} logo={logo} size="sm" />
      ) : null}
      <h2 className="text-lg font-semibold text-foreground">{name}</h2>
      <span className="text-xs text-muted-foreground">
        {t("subscriptions.grouped.subscriptionCount", { count })}
      </span>
      {totalMonthly > 0 ? (
        <span className="ml-auto text-sm font-medium text-muted-foreground">
          {t("subscriptions.grouped.totalMonthlyCost", {
            amount: formatCurrency(totalMonthly, defaultCurrency, locale),
          })}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="subscription-grouped-view">
      {groupedBuckets.map(({ group, items, totalMonthly }) => {
        const isCollapsed = collapsedGroups.has(group.id);
        return (
          <Collapsible
            key={group.id}
            open={!isCollapsed}
            onOpenChange={() => toggleGroup(group.id)}
            className="rounded-xl border border-border bg-card/50"
          >
            <CollapsibleTrigger className="w-full px-4 py-3 text-left hover:bg-card-hover/50 transition-colors">
              {renderGroupHeader(group.name, group.logo, items.length, totalMonthly, isCollapsed)}
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              {renderCards(items)}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      {ungroupedItems.length > 0 ? (
        <Collapsible
          defaultOpen
          className="rounded-xl border border-border bg-card/50"
        >
          <CollapsibleTrigger className="w-full px-4 py-3 text-left hover:bg-card-hover/50 transition-colors">
            {renderGroupHeader(
              t("subscriptions.grouped.ungrouped"),
              undefined,
              ungroupedItems.length,
              ungroupedMonthly,
              false,
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className="px-4 pb-4">
            {renderCards(ungroupedItems)}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
