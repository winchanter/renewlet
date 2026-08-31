import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Layers,
  Link2,
  Monitor,
  Moon,
  Sun,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { useParams } from "react-router";
import { toast } from "@/components/ui/sonner";
import { SubscriptionLogo } from "@/components/subscription-logo";
import { SubscriptionStatusBadge } from "@/components/subscription-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { Textarea } from "@/components/ui/textarea";
import { TruncatedTooltipText } from "@/components/ui/truncated-tooltip-text";
import { ApiError } from "@/lib/api-client";
import { colorWithAlpha } from "@/lib/color";
import { formatCompactCurrencyAmount, formatCurrency } from "@/lib/currency";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme-provider";
import { daysBetweenDateOnly, formatDateOnlyMonthDay, todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { usePublicStatus } from "@/hooks/use-public-status-page";
import { useExchangeRates } from "@/hooks/use-exchange-rates";
import { useI18n } from "@/i18n/I18nProvider";
import { localizedLabel, type Locale } from "@/i18n/locales";
import { translate, type MessageKey } from "@/i18n/messages";
import { publicStatusService } from "@/services/public-status-service";
import { copyTextToClipboard } from "@/shared/browser/clipboard";
import {
  customCycleUnitLabelKey,
  toDailyAmountFromMonthly,
  toMonthlyAmount,
} from "@/lib/subscription-billing";
import type { PublicStatusResponse, PublicStatusVault } from "@/lib/api/schemas/public-status";
import type { VaultPublicRedeemPayload } from "@/lib/api/schemas/vault";
import { CYCLE_LABELS } from "@/types/subscription";
import type { ThemeMode } from "@/types/theme";
import { moneyToNumber } from "@renewlet/shared/money";
import { requireCustomBillingCycle } from "@renewlet/shared/subscription-renewal";

type PublicStatusSubscription = PublicStatusResponse["subscriptions"][number];
type PublicStatusExchangeRateBasis = NonNullable<PublicStatusResponse["page"]["exchangeRateBasis"]>;
type PublicStatusCurrencyConverter = (amount: number | string, fromCurrency: string, toCurrency: string) => number;

interface PublicStatusThemeOption {
  value: ThemeMode;
  labelKey: MessageKey;
  Icon: LucideIcon;
}

const SYSTEM_PUBLIC_STATUS_THEME_OPTION: PublicStatusThemeOption = {
  value: "system",
  labelKey: "theme.system",
  Icon: Monitor,
};

const PUBLIC_STATUS_THEME_OPTIONS: PublicStatusThemeOption[] = [
  { value: "light", labelKey: "theme.light", Icon: Sun },
  { value: "dark", labelKey: "theme.dark", Icon: Moon },
  SYSTEM_PUBLIC_STATUS_THEME_OPTION,
];

function useNoIndexMeta() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Renewo Status";

    const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousContent = existing?.getAttribute("content") ?? null;
    const meta = existing ?? document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "noindex,nofollow");
    if (!existing) document.head.appendChild(meta);

    return () => {
      document.title = previousTitle;
      if (existing) {
        if (previousContent === null) {
          existing.removeAttribute("content");
        } else {
          existing.setAttribute("content", previousContent);
        }
      } else {
        meta.remove();
      }
    };
  }, []);
}

function PublicStatusFrame({ children }: { children: ReactNode }) {
  return (
    <div className="app-page bg-background">
      <main className="app-main mx-auto max-w-7xl">
        {children}
      </main>
    </div>
  );
}

function PublicStatusLoading() {
  return (
    <PublicStatusFrame>
      <div className="grid gap-8">
        <div className="mb-1">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="mt-2 h-4 w-64 max-w-full" />
        </div>
        <div className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-32 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-44 rounded-xl" />
          ))}
        </div>
      </div>
    </PublicStatusFrame>
  );
}

function PublicStatusThemeMenu() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  const currentOption = PUBLIC_STATUS_THEME_OPTIONS.find((option) => option.value === theme)
    ?? SYSTEM_PUBLIC_STATUS_THEME_OPTION;
  const CurrentIcon = currentOption.Icon;

  const handleThemeChange = (value: string) => {
    if (value === "light" || value === "dark" || value === "system") {
      setTheme(value);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("header.toggleTheme")}
          className="h-10 w-10 shrink-0 border border-border bg-card/80 text-muted-foreground hover:bg-card-hover hover:text-foreground focus-visible:ring-ring sm:h-9 sm:w-9"
          size="icon"
          variant="ghost"
        >
          <CurrentIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup value={theme} onValueChange={handleThemeChange}>
          {PUBLIC_STATUS_THEME_OPTIONS.map(({ value, labelKey, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span>{t(labelKey)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PublicStatusHeader({
  data,
  showGroupToggle,
  grouped,
  onToggleGrouped,
}: {
  data: PublicStatusResponse;
  showGroupToggle: boolean;
  grouped: boolean;
  onToggleGrouped: () => void;
}) {
  const { t, formatDateTime } = useI18n();

  return (
    <header className="mb-8 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-foreground">{t("publicStatus.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("publicStatus.headerMeta", { time: formatDateTime(data.page.generatedAt) })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {showGroupToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("subscriptions.groupedView")}
            aria-pressed={grouped}
            onClick={onToggleGrouped}
            className={cn(
              "h-10 w-10 shrink-0 border border-border bg-card/80 text-muted-foreground hover:bg-card-hover hover:text-foreground focus-visible:ring-ring sm:h-9 sm:w-9",
              grouped && "bg-primary/10 text-primary",
            )}
          >
            <Layers className="h-4 w-4" />
          </Button>
        ) : null}
        <PublicStatusThemeMenu />
      </div>
    </header>
  );
}

function PublicStatusError({ notFound }: { notFound: boolean }) {
  const { t } = useI18n();
  return (
    <PublicStatusFrame>
      <div className="mx-auto flex min-h-[calc(var(--app-viewport-height)-8rem)] max-w-lg flex-col items-center justify-center px-4 py-12 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">
          {notFound ? t("publicStatus.notFoundTitle") : t("publicStatus.errorTitle")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {notFound ? t("publicStatus.notFoundDescription") : t("publicStatus.errorDescription")}
        </p>
      </div>
    </PublicStatusFrame>
  );
}

function publicStatusStats(data: PublicStatusResponse) {
  const today = todayDateOnlyInTimeZone(new Date(data.page.generatedAt), "UTC");
  return data.subscriptions.reduce(
    (counts, subscription) => {
      const isActiveLike = subscription.status === "active" || subscription.status === "trial";
      const daysUntilBilling = daysBetweenDateOnly(today, subscription.nextBillingDate);
      return {
        visible: counts.visible + 1,
        active: counts.active + (isActiveLike ? 1 : 0),
        upcoming: counts.upcoming + (isActiveLike && daysUntilBilling >= 0 && daysUntilBilling <= 7 ? 1 : 0),
        inactive: counts.inactive + (["expired", "paused", "cancelled"].includes(subscription.status) ? 1 : 0),
      };
    },
    { visible: 0, active: 0, upcoming: 0, inactive: 0 },
  );
}

function publicStatusMonthlyTotalOf(
  subscriptions: readonly PublicStatusSubscription[],
  currency: string,
  convert: (amount: number | string, from: string, to: string) => number,
) {
  return subscriptions.reduce((sum, subscription) => {
    if (subscription.status !== "active" && subscription.status !== "trial") return sum;
    if (
      subscription.price === undefined
      || !subscription.currency
      || !subscription.billingCycle
    ) {
      return sum;
    }
    const amount = convert(subscription.price, subscription.currency, currency);
    const monthly = toMonthlyAmount(
      amount,
      subscription.billingCycle,
      subscription.customDays,
      subscription.customCycleUnit,
      subscription.oneTimeTermCount,
      subscription.oneTimeTermUnit,
      subscription.usageTotal,
      subscription.usageDailyRate,
    );
    return Number.isFinite(monthly) ? sum + monthly : sum;
  }, 0);
}

function publicStatusMonthlyTotal(
  data: PublicStatusResponse,
  convert: (amount: number | string, from: string, to: string) => number,
) {
  const targetCurrency = data.page.currency;
  if (!data.page.showPrices || !targetCurrency) return 0;
  return publicStatusMonthlyTotalOf(data.subscriptions, targetCurrency, convert);
}

function publicStatusConverterFromBasis(basis: PublicStatusExchangeRateBasis | undefined) {
  if (!basis || basis.status !== "locked") return null;
  return (amount: number | string, fromCurrency: string, toCurrency: string): number => {
    const numericAmount = moneyToNumber(amount);
    if (fromCurrency === toCurrency) return numericAmount;
    const fromRate = basis.rates[fromCurrency] || 1;
    const toRate = basis.rates[toCurrency] || 1;
    return (numericAmount / fromRate) * toRate;
  };
}

function PublicStatusSummary({ data }: { data: PublicStatusResponse }) {
  if (data.page.showPrices && data.page.currency) {
    return <PublicStatusMoneySummary data={data} />;
  }
  return <PublicStatusCountSummary data={data} />;
}

function PublicStatusMoneySummary({ data }: { data: PublicStatusResponse }) {
  const { t, formatCurrency, formatNumber } = useI18n();
  const lockedConvert = publicStatusConverterFromBasis(data.page.exchangeRateBasis);
  if (lockedConvert) {
    // 匿名公开页拿到 locked basis 时不能再挂实时汇率 hook；否则快照口径仍会触发浏览器直连外部 provider。
    return (
      <PublicStatusMoneyCards
        data={data}
        convert={lockedConvert}
        moneySubtitle={t("publicStatus.moneySubtitleLocked", { month: data.page.exchangeRateBasis?.month ?? "" })}
        formatCurrency={formatCurrency}
        formatNumber={formatNumber}
      />
    );
  }

  return <PublicStatusLiveMoneySummary data={data} />;
}

function PublicStatusLiveMoneySummary({ data }: { data: PublicStatusResponse }) {
  const { t, formatCurrency, formatNumber } = useI18n();
  const { convert, loading: ratesLoading } = useExchangeRates();
  const currency = data.page.currency;
  if (!currency) return null;
  const moneySubtitle = ratesLoading
    ? t("publicStatus.ratesLoading")
    : data.page.exchangeRateBasis?.status === "live"
      ? t("publicStatus.moneySubtitleLive", { currency })
      : t("publicStatus.moneySubtitle", { currency });

  return (
    <PublicStatusMoneyCards
      data={data}
      convert={convert}
      moneySubtitle={moneySubtitle}
      formatCurrency={formatCurrency}
      formatNumber={formatNumber}
    />
  );
}

function PublicStatusMoneyCards({
  data,
  convert,
  moneySubtitle,
  formatCurrency,
  formatNumber,
}: {
  data: PublicStatusResponse;
  convert: PublicStatusCurrencyConverter;
  moneySubtitle: string;
  formatCurrency: ReturnType<typeof useI18n>["formatCurrency"];
  formatNumber: ReturnType<typeof useI18n>["formatNumber"];
}) {
  const stats = publicStatusStats(data);
  const monthlyTotal = publicStatusMonthlyTotal(data, convert);
  const currency = data.page.currency;
  const { t, locale } = useI18n();
  if (!currency) return null;
  // 公开汇总日均必须复用已按 locked/live 口径算出的月均，不能再次换汇形成第二套匿名页金额结果。
  const dailyTotal = toDailyAmountFromMonthly(monthlyTotal);
  const monthlySubtitle = t("publicStatus.monthlyTotalSubtitle", {
    amount: formatCompactCurrencyAmount(dailyTotal, currency, locale),
    basis: moneySubtitle,
  });

  return (
    <div className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
      <StatCard
        title={t("publicStatus.monthlyTotal")}
        value={formatCurrency(monthlyTotal, currency)}
        subtitle={monthlySubtitle}
        icon={<CreditCard className="h-6 w-6" />}
        variant="primary"
        className="animate-fade-in"
      />
      <StatCard
        title={t("publicStatus.annualTotal")}
        value={formatCurrency(monthlyTotal * 12, currency)}
        subtitle={moneySubtitle}
        icon={<TrendingUp className="h-6 w-6" />}
        className="animate-fade-in [animation-delay:100ms]"
      />
      <StatCard
        title={t("publicStatus.visibleCount")}
        value={formatNumber(stats.visible)}
        subtitle={t("publicStatus.visibleMoneySubtitle", { count: formatNumber(stats.active) })}
        icon={<Eye className="h-6 w-6" />}
        className="animate-fade-in [animation-delay:200ms]"
      />
      <StatCard
        title={t("publicStatus.upcomingCount")}
        value={formatNumber(stats.upcoming)}
        subtitle={t("publicStatus.upcomingSubtitle")}
        icon={<CalendarClock className="h-6 w-6" />}
        variant={stats.upcoming > 0 ? "warning" : "default"}
        className="animate-fade-in [animation-delay:300ms]"
      />
    </div>
  );
}

function PublicStatusCountSummary({ data }: { data: PublicStatusResponse }) {
  const { t, formatNumber } = useI18n();
  const stats = publicStatusStats(data);

  return (
    <div className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
      <StatCard
        title={t("publicStatus.visibleCount")}
        value={formatNumber(stats.visible)}
        icon={<Eye className="h-6 w-6" />}
        variant="primary"
        className="animate-fade-in"
      />
      <StatCard
        title={t("publicStatus.activeCount")}
        value={formatNumber(stats.active)}
        icon={<Activity className="h-6 w-6" />}
        className="animate-fade-in [animation-delay:100ms]"
      />
      <StatCard
        title={t("publicStatus.upcomingCount")}
        value={formatNumber(stats.upcoming)}
        subtitle={t("publicStatus.upcomingSubtitle")}
        icon={<CalendarClock className="h-6 w-6" />}
        variant={stats.upcoming > 0 ? "warning" : "default"}
        className="animate-fade-in [animation-delay:200ms]"
      />
      <StatCard
        title={t("publicStatus.inactiveCount")}
        value={formatNumber(stats.inactive)}
        subtitle={t("publicStatus.inactiveSubtitle")}
        icon={<AlertCircle className="h-6 w-6" />}
        className="animate-fade-in [animation-delay:300ms]"
      />
    </div>
  );
}

function publicBillingCycleLabel(subscription: PublicStatusSubscription, locale: Locale) {
  if (!subscription.billingCycle) return null;
  if (subscription.billingCycle !== "custom") return localizedLabel(CYCLE_LABELS[subscription.billingCycle], locale);
  const custom = requireCustomBillingCycle(subscription.customDays, subscription.customCycleUnit);
  const unitLabel = translate(locale, customCycleUnitLabelKey(custom.unit));
  return translate(locale, "subscription.customCycleLabel", { count: custom.count, unit: unitLabel });
}

function publicSubscriptionDailyAmount(subscription: PublicStatusSubscription) {
  // 单条日均只能从 showPrices 后的公开价格投影派生；字段缺失时不得补默认值或读取私有 Subscription。
  if (subscription.price === undefined || !subscription.currency || !subscription.billingCycle) return null;
  // 买断和零价周期订阅的月均都可能为零，必须按服务期字段区分，不能用金额正负决定是否展示。
  if (subscription.billingCycle === "one-time" && !subscription.oneTimeTermCount) return null;
  const monthlyAmount = toMonthlyAmount(
    subscription.price,
    subscription.billingCycle,
    subscription.customDays,
    subscription.customCycleUnit,
    subscription.oneTimeTermCount,
    subscription.oneTimeTermUnit,
    subscription.usageTotal,
    subscription.usageDailyRate,
  );
  return Number.isFinite(monthlyAmount)
    ? toDailyAmountFromMonthly(monthlyAmount)
    : null;
}

function PublicSubscriptionCard({
  subscription,
  onRequestAccess,
}: {
  subscription: PublicStatusSubscription;
  onRequestAccess?: (() => void) | undefined;
}) {
  const { t, locale, formatCurrency, formatDateOnly, formatDateTime } = useI18n();
  const categoryColor = subscription.category.color ?? "hsl(var(--primary))";
  const billingCycleLabel = publicBillingCycleLabel(subscription, locale);
  const dailyAmount = publicSubscriptionDailyAmount(subscription);
  const categoryStyle = {
    backgroundColor: colorWithAlpha(categoryColor, 0.1) ?? undefined,
    borderColor: colorWithAlpha(categoryColor, 0.2) ?? undefined,
    color: categoryColor,
  };

  // 公开 API 只有 allowlist 字段；这里复用视觉原语而不是伪造完整 Subscription，避免私有字段被带入公开组件。
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card p-5 shadow-card transition-all duration-300 hover:bg-card-hover">
      <div className="flex flex-1 items-start gap-4">
        <SubscriptionLogo
          name={subscription.name}
          logo={subscription.logo}
          fallbackColor={categoryColor}
          size="md"
        />

        <div className="grid min-w-0 flex-1 gap-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div className="min-w-0">
              <TruncatedTooltipText
                as="h2"
                text={subscription.name}
                className="min-w-0 font-semibold text-foreground"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("publicStatus.updatedAt", { time: formatDateTime(subscription.updatedAt) })}
              </p>
            </div>
            {subscription.price !== undefined && subscription.currency ? (
              <div className="shrink-0 text-right">
                <p className="whitespace-nowrap text-xl font-bold text-foreground">
                  {formatCurrency(subscription.price, subscription.currency)}
                </p>
                {billingCycleLabel ? (
                  <p className="text-xs text-muted-foreground">{billingCycleLabel}</p>
                ) : null}
              </div>
            ) : null}

            <div className="col-span-full flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="max-w-full shrink-0 overflow-hidden whitespace-nowrap text-xs"
                style={categoryStyle}
              >
                <TruncatedTooltipText text={subscription.category.label} className="block max-w-full" />
              </Badge>
              <SubscriptionStatusBadge status={subscription.status} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {dailyAmount !== null && subscription.currency ? (
              <div className="flex items-center gap-1.5 tabular-nums text-muted-foreground">
                <Gauge className="h-3.5 w-3.5" />
                <span className="text-xs">
                  {t("publicStatus.subscriptionDailyAverage", {
                    amount: formatCompactCurrencyAmount(dailyAmount, subscription.currency, locale),
                  })}
                </span>
              </div>
            ) : null}
            {subscription.startDate ? (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                <span className="text-xs">
                  {t("publicStatus.startDate", { date: formatDateOnly(subscription.startDate) })}
                </span>
              </div>
            ) : null}
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              <span className="text-xs">
                {t("publicStatus.nextBillingDate", { date: formatDateOnly(subscription.nextBillingDate) })}
              </span>
            </div>
          </div>
        </div>
      </div>
      {onRequestAccess ? (
        <div className="-mb-2.5 mt-3 flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={onRequestAccess}>
            <KeyRound className="h-3.5 w-3.5" />
            {t("publicStatus.vault.tabRequest")}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

// ================== P2：公开页即将到期独立分组 ==================

type PublicStatusUpcomingKind = "renewal" | "expiry";

interface PublicStatusUpcomingItem {
  subscription: PublicStatusSubscription;
  kind: PublicStatusUpcomingKind;
  daysUntil: number;
}

/**
 * 构建公开页「即将到期」列表条目。
 *
 * 视觉规则参考仪表盘 UpcomingRenewals：仅展示提醒窗口内（默认 0–7 天）的 active/trial
 * 订阅，跳过买断无服务期项（无 nextBillingDate 续费意义）。窗口长度复用 publicStatusStats
 * 中已有的 7 天口径，避免公开页与统计卡片计数口径不一致。
 */
function buildPublicStatusUpcomingItems(data: PublicStatusResponse): PublicStatusUpcomingItem[] {
  const today = todayDateOnlyInTimeZone(new Date(data.page.generatedAt), "UTC");
  const items: PublicStatusUpcomingItem[] = [];
  for (const subscription of data.subscriptions) {
    const isActiveLike = subscription.status === "active" || subscription.status === "trial";
    if (!isActiveLike) continue;
    if (subscription.billingCycle === "one-time" && !subscription.oneTimeTermCount) continue;
    const daysUntil = daysBetweenDateOnly(today, subscription.nextBillingDate);
    if (daysUntil < 0 || daysUntil > 7) continue;
    items.push({
      subscription,
      kind: subscription.billingCycle === "one-time" ? "expiry" : "renewal",
      daysUntil,
    });
  }
  return items.sort((a, b) => {
    if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
    return a.subscription.name.localeCompare(b.subscription.name);
  });
}

/**
 * 公开页「即将到期」独立分组：在订阅列表上方以紧凑行卡片展示未来 7 天的续费/到期项。
 *
 * 视觉规则参考仪表盘 UpcomingRenewals 组件：
 * - 最多 5 条，移动端单列，sm 起两列，xl 起三列
 * - 倒数 3 天内的项以 warning 高亮提示紧迫度
 * - 价格展示受 page.showPrices 控制，与 PublicSubscriptionCard 口径一致
 * - 公开页为只读访问，整行不做点击交互（不触发详情或续订弹窗）
 */
function PublicStatusUpcomingSection({ data }: { data: PublicStatusResponse }) {
  const { t, locale, formatCurrency } = useI18n();
  const items = buildPublicStatusUpcomingItems(data).slice(0, 5);
  if (items.length === 0) return null;
  const showPrices = data.page.showPrices;

  return (
    <section
      aria-label={t("publicStatus.upcomingCount")}
      className="rounded-xl border border-border bg-card p-5 shadow-card sm:p-6"
    >
      <div className="mb-4 flex items-center gap-2">
        <CalendarClock className="h-5 w-5 text-primary" />
        <h3 className="text-base font-semibold text-foreground sm:text-lg">{t("publicStatus.upcomingCount")}</h3>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const subscription = item.subscription;
          const isUrgent = item.daysUntil <= 3;
          const hasPrice = showPrices && subscription.price !== undefined && subscription.currency !== undefined;
          return (
            <div
              key={`${subscription.name}-${subscription.nextBillingDate}-${item.kind}`}
              className={cn(
                "flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/50 p-4",
                isUrgent && "border-warning/30 bg-warning/5",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold",
                    isUrgent ? "bg-warning/20 text-warning" : "bg-muted text-muted-foreground",
                  )}
                >
                  {item.daysUntil === 0
                    ? t("upcoming.todayShort")
                    : t("upcoming.daysShort", { days: item.daysUntil })}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground" title={subscription.name}>
                    {subscription.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.kind === "expiry"
                      ? t("upcoming.expiresOn", { date: formatDateOnlyMonthDay(subscription.nextBillingDate, locale) })
                      : t("upcoming.renewsOn", { date: formatDateOnlyMonthDay(subscription.nextBillingDate, locale) })}
                  </p>
                </div>
              </div>
              {hasPrice ? (
                <p className="shrink-0 font-semibold text-foreground">
                  {formatCurrency(subscription.price!, subscription.currency!)}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ================== P4：公开页订阅分组视图 ==================

type PublicStatusGroupedConverter = PublicStatusCurrencyConverter | null;

interface PublicStatusGroupedViewProps {
  data: PublicStatusResponse;
  /** locked/live 汇率换算器；null 表示金额关闭或汇率加载中，组头不显示月均。 */
  convert: PublicStatusGroupedConverter;
  requestableNames: Set<string>;
  onRequestAccess: (name: string) => void;
}

/**
 * 公开页分组视图入口：locked basis 直接用快照换算；live 汇率走 hook（hook 不能条件调用，
 * 拆成独立子组件保证分支内 hook 顺序稳定）。
 */
function PublicStatusGroupedViewSection(props: Omit<PublicStatusGroupedViewProps, "convert">) {
  const { data } = props;
  const lockedConvert = publicStatusConverterFromBasis(data.page.exchangeRateBasis);
  if (lockedConvert || !data.page.showPrices || !data.page.currency) {
    return <PublicStatusGroupedView {...props} convert={lockedConvert} />;
  }
  return <PublicStatusGroupedViewLive {...props} />;
}

function PublicStatusGroupedViewLive(props: Omit<PublicStatusGroupedViewProps, "convert">) {
  const { convert, loading } = useExchangeRates();
  return <PublicStatusGroupedView {...props} convert={loading ? null : convert} />;
}

/**
 * 公开页订阅分组视图：按订阅组折叠展示，视觉规则参考管理后台 SubscriptionGroupedView。
 *
 * 隐私口径：组名/logo 由服务端按「组内存在公开可见订阅」过滤后输出，前端按下标分桶；
 * 未分组订阅复用「未分组」折叠区。组月均仅在 showPrices 开启且汇率就绪时显示，
 * 换算口径与统计卡一致（locked 快照或 live 汇率），不复算第二套金额。
 */
function PublicStatusGroupedView({ data, convert, requestableNames, onRequestAccess }: PublicStatusGroupedViewProps) {
  const { t, locale } = useI18n();
  const currency = data.page.showPrices ? data.page.currency : undefined;

  const { groupedBuckets, ungroupedItems } = useMemo(() => {
    const buckets = new Map<number, PublicStatusSubscription[]>();
    const ungrouped: PublicStatusSubscription[] = [];
    for (const subscription of data.subscriptions) {
      // schema 已约束 groupIndex 指向存在的组；越界防御性归入未分组，避免渲染崩溃。
      if (subscription.groupIndex === undefined || subscription.groupIndex >= data.groups.length) {
        ungrouped.push(subscription);
        continue;
      }
      const bucket = buckets.get(subscription.groupIndex);
      if (bucket) bucket.push(subscription);
      else buckets.set(subscription.groupIndex, [subscription]);
    }
    const bucketsList = data.groups
      .map((group, index) => ({ group, items: buckets.get(index) ?? [] }))
      .filter((bucket) => bucket.items.length > 0);
    return { groupedBuckets: bucketsList, ungroupedItems: ungrouped };
  }, [data]);

  // 默认展开所有组；公开页为匿名访问，折叠状态不持久化。
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());
  const toggleGroup = (index: number) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const groupMonthlyTotal = (items: PublicStatusSubscription[]) => {
    if (!currency || !convert) return null;
    return publicStatusMonthlyTotalOf(items, currency, convert);
  };

  const renderCards = (items: PublicStatusSubscription[]) => (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((subscription, index) => (
        <div
          key={`${subscription.name}-${subscription.startDate ?? "unknown"}-${subscription.nextBillingDate}-${index}`}
          className="h-full animate-fade-in"
          style={{ animationDelay: `${index * 40}ms` }}
        >
          <PublicSubscriptionCard
            subscription={subscription}
            onRequestAccess={requestableNames.has(subscription.name)
              ? () => onRequestAccess(subscription.name)
              : undefined}
          />
        </div>
      ))}
    </div>
  );

  const renderGroupHeader = (
    name: string,
    logo: string | null | undefined,
    count: number,
    monthly: number | null,
    isCollapsed: boolean,
  ) => (
    <div className="flex items-center gap-3">
      <ChevronDown
        className={cn(
          "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
          isCollapsed && "-rotate-90",
        )}
      />
      {logo ? <SubscriptionLogo name={name} logo={logo} size="sm" /> : null}
      <h3 className="min-w-0 truncate text-base font-semibold text-foreground">{name}</h3>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("subscriptions.grouped.subscriptionCount", { count })}
      </span>
      {monthly !== null && monthly > 0 && currency ? (
        <span className="ml-auto shrink-0 text-sm font-medium text-muted-foreground">
          {t("subscriptions.grouped.totalMonthlyCost", { amount: formatCurrency(monthly, currency, locale) })}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="grid gap-4" data-testid="public-status-grouped-view">
      {groupedBuckets.map(({ group, items }, groupIndex) => {
        const isCollapsed = collapsedGroups.has(groupIndex);
        const monthly = groupMonthlyTotal(items);
        return (
          <Collapsible
            key={`${group.name}-${groupIndex}`}
            open={!isCollapsed}
            onOpenChange={() => toggleGroup(groupIndex)}
            className="rounded-xl border border-border bg-card/50"
          >
            <CollapsibleTrigger className="w-full px-4 py-3 text-left transition-colors hover:bg-card-hover/50">
              {renderGroupHeader(group.name, group.logo, items.length, monthly, isCollapsed)}
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4">
              {renderCards(items)}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      {ungroupedItems.length > 0 ? (
        <Collapsible defaultOpen className="rounded-xl border border-border bg-card/50">
          <CollapsibleTrigger className="w-full px-4 py-3 text-left transition-colors hover:bg-card-hover/50">
            {renderGroupHeader(
              t("subscriptions.grouped.ungrouped"),
              undefined,
              ungroupedItems.length,
              groupMonthlyTotal(ungroupedItems),
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

// ================== P3：公开页账号访问（vault） ==================

function PublicVaultFieldRow({
  label,
  value,
  secret = false,
  link = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
  link?: boolean;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const displayValue = secret && !visible ? "•".repeat(Math.max(value.length, 8)) : value;
  const handleCopy = async () => {
    const copyResult = await copyTextToClipboard(value);
    if (copyResult.ok) {
      toast.success(t("publicStatus.vault.copied"));
    } else {
      toast.error(t("publicStatus.vault.copyFailed"));
    }
  };
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {secret ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => setVisible((previous) => !previous)}
              aria-label={visible ? t("publicStatus.vault.hidePassword") : t("publicStatus.vault.revealPassword")}
            >
              {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {visible ? t("publicStatus.vault.hidePassword") : t("publicStatus.vault.revealPassword")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={() => void handleCopy()}
            aria-label={t("publicStatus.vault.copy")}
          >
            <Copy className="h-3.5 w-3.5" />
            {t("publicStatus.vault.copy")}
          </Button>
        </div>
      </div>
      {link && value ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 break-all text-sm text-primary hover:underline"
        >
          <Link2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{displayValue}</span>
        </a>
      ) : (
        <p className="min-w-0 break-all font-mono text-sm text-foreground">
          {displayValue || <span className="font-sans text-muted-foreground">—</span>}
        </p>
      )}
    </div>
  );
}

function PublicVaultRedeemResult({ result }: { result: VaultPublicRedeemPayload }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 rounded-lg border border-border bg-background/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">{t("publicStatus.vault.resultTitle")}</p>
        </div>
        {result.subscriptionName || result.groupName ? (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {result.subscriptionName ? (
              <Badge variant="secondary" className="max-w-[12rem] gap-1 rounded-full px-2.5 font-normal">
                <span className="shrink-0 text-muted-foreground">{t("publicStatus.vault.fieldSubscription")}</span>
                <span className="truncate font-medium text-foreground" title={result.subscriptionName}>
                  {result.subscriptionName}
                </span>
              </Badge>
            ) : null}
            {result.groupName ? (
              <Badge variant="secondary" className="max-w-[12rem] gap-1 rounded-full px-2.5 font-normal">
                <span className="shrink-0 text-muted-foreground">{t("publicStatus.vault.fieldGroup")}</span>
                <span className="truncate font-medium text-foreground" title={result.groupName}>
                  {result.groupName}
                </span>
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
      <PublicVaultFieldRow label={t("publicStatus.vault.fieldTitle")} value={result.title} />
      {result.username ? (
        <PublicVaultFieldRow label={t("publicStatus.vault.fieldUsername")} value={result.username} />
      ) : null}
      {result.password ? (
        <PublicVaultFieldRow label={t("publicStatus.vault.fieldPassword")} value={result.password} secret />
      ) : null}
      {result.url ? (
        <PublicVaultFieldRow label={t("publicStatus.vault.fieldUrl")} value={result.url} link />
      ) : null}
      {result.notes ? (
        <PublicVaultFieldRow label={t("publicStatus.vault.fieldNotes")} value={result.notes} />
      ) : null}
    </div>
  );
}

function PublicVaultRedeemForm({ token }: { token: string }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<VaultPublicRedeemPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const trimmedCode = code.trim();
    if (!trimmedCode) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = await publicStatusService.redeemPublicVaultCode(token, { code: trimmedCode });
      setResult(payload);
      setCode("");
      toast.success(t("publicStatus.vault.redeemSuccessToast"));
    } catch (submitError) {
      // 失败只刷新错误条，已解锁结果保持展示，避免误触表单清空访客刚拿到的凭据。
      setError(getDisplayErrorMessage(submitError, t("publicStatus.vault.redeemFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="grid gap-3" onSubmit={(event) => void handleSubmit(event)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="public-vault-code" className="sr-only">
          {t("publicStatus.vault.codeLabel")}
        </label>
        <Input
          id="public-vault-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t("publicStatus.vault.codePlaceholder")}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={submitting}
          aria-label={t("publicStatus.vault.codeLabel")}
          className="h-9 min-w-0 flex-1 border-border bg-background font-mono"
        />
        <Button type="submit" size="sm" disabled={submitting || !code.trim()} className="h-9 shrink-0 justify-center gap-2">
          <KeyRound className="h-4 w-4" />
          {submitting ? t("publicStatus.vault.redeeming") : t("publicStatus.vault.redeemSubmit")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm leading-5 text-destructive">
          {error}
        </p>
      ) : null}
      {result ? <PublicVaultRedeemResult result={result} /> : null}
    </form>
  );
}

function PublicVaultRequestForm({
  token,
  subscriptions,
  initialSubscriptionId = "",
  locked = false,
}: {
  token: string;
  subscriptions: PublicStatusVault["subscriptions"];
  initialSubscriptionId?: string;
  /** 锁定订阅选择（订阅卡片入口）：预选当前订阅且不可更改。 */
  locked?: boolean | undefined;
}) {
  const { t } = useI18n();
  const [subscriptionId, setSubscriptionId] = useState(initialSubscriptionId);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = subscriptions.map((subscription) => ({ value: subscription.id, label: subscription.name }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !subscriptionId) return;
    setSubmitting(true);
    setError(null);
    try {
      const trimmedNote = note.trim();
      await publicStatusService.createPublicVaultAccessRequest(token, {
        subscriptionId,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      });
      setSubmitted(true);
      toast.success(t("publicStatus.vault.requestSuccessToast"));
    } catch (submitError) {
      setError(getDisplayErrorMessage(submitError, t("publicStatus.vault.requestFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="grid gap-2 rounded-lg border border-border bg-background/60 p-4">
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">{t("publicStatus.vault.requestSuccessTitle")}</p>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">{t("publicStatus.vault.requestSuccessDescription")}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit justify-center border-border"
          onClick={() => {
            setSubmitted(false);
            setSubscriptionId("");
            setNote("");
          }}
        >
          {t("publicStatus.vault.requestAgain")}
        </Button>
      </div>
    );
  }

  return (
    <form className="grid gap-3" onSubmit={(event) => void handleSubmit(event)}>
      <div className="grid gap-1.5">
        <label htmlFor="public-vault-subscription" className="text-sm font-medium text-foreground">
          {t("publicStatus.vault.subscriptionLabel")}
        </label>
        <SearchableSelect
          id="public-vault-subscription"
          value={subscriptionId}
          onValueChange={setSubscriptionId}
          options={options}
          placeholder={t("publicStatus.vault.subscriptionPlaceholder")}
          searchPlaceholder={t("publicStatus.vault.subscriptionSearch")}
          emptyMessage={t("publicStatus.vault.subscriptionEmpty")}
          disabled={submitting || locked}
          className={cn("h-9 w-full border-border bg-background", locked && "cursor-not-allowed bg-secondary/60")}
          aria-label={t("publicStatus.vault.subscriptionLabel")}
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="public-vault-note" className="text-sm font-medium text-foreground">
          {t("publicStatus.vault.noteLabel")}
        </label>
        <Textarea
          id="public-vault-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t("publicStatus.vault.notePlaceholder")}
          rows={3}
          maxLength={500}
          disabled={submitting}
          className="resize-none border-border bg-background"
        />
      </div>
      <Button type="submit" size="sm" disabled={submitting || !subscriptionId} className="w-full justify-center gap-2 sm:w-fit">
        {submitting ? t("publicStatus.vault.requestSubmitting") : t("publicStatus.vault.requestSubmit")}
      </Button>
      {error ? (
        <p role="alert" className="text-sm leading-5 text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * 公开页「解锁账号」入口：位于统计与订阅列表之间的独立紧凑卡片。
 *
 * 安全边界：未开启（vault.enabled=false）不渲染；解锁凭据只在访客持有
 * 有效授权码时由服务端返回，前端不做本地数据回退。
 */
function PublicVaultRedeemCard({ token }: { token: string }) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("publicStatus.vault.tabRedeem")}
      className="rounded-xl border border-border bg-card p-5 shadow-card"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-8">
        <div className="flex min-w-0 items-center gap-3 lg:w-80 lg:shrink-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-primary">
            <KeyRound className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-foreground">{t("publicStatus.vault.tabRedeem")}</h2>
            <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
              {t("publicStatus.vault.redeemDescription")}
            </p>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <PublicVaultRedeemForm token={token} />
        </div>
      </div>
    </section>
  );
}

/**
 * 公开页「申请访问」弹窗：由订阅卡片上的按钮触发，订阅选择器预选当前订阅。
 *
 * 安全边界：订阅摘要只含 id/name，由服务端在开关开启时输出；公开订阅投影
 * 不含 id，卡片入口只能按 name 匹配预选，访客仍可在弹窗内改选。
 */
function PublicVaultRequestDialog({
  token,
  vault,
  targetName,
  onClose,
}: {
  token: string;
  vault: PublicStatusVault;
  targetName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const initialSubscriptionId = vault.subscriptions.find(
    (subscription) => subscription.name === targetName,
  )?.id ?? "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("publicStatus.vault.tabRequest")}</DialogTitle>
          <DialogDescription>{t("publicStatus.vault.requestDescription")}</DialogDescription>
        </DialogHeader>
        <PublicVaultRequestForm
          token={token}
          subscriptions={vault.subscriptions}
          initialSubscriptionId={initialSubscriptionId}
          locked
        />
      </DialogContent>
    </Dialog>
  );
}

export default function PublicStatusPage() {
  useNoIndexMeta();
  const { token } = useParams<{ token: string }>();
  const query = usePublicStatus(token);
  const { t } = useI18n();
  const [requestTargetName, setRequestTargetName] = useState<string | null>(null);
  const [groupedView, setGroupedView] = useState(false);

  if (query.isPending) {
    return <PublicStatusLoading />;
  }

  if (query.isError || !query.data) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return <PublicStatusError notFound={notFound} />;
  }

  const data = query.data;
  const normalizedToken = token?.trim() ?? "";
  const vaultEnabled = data.vault.enabled;
  const requestableNames = new Set(data.vault.subscriptions.map((subscription) => subscription.name));
  const showGroupToggle = data.groups.length > 0 && data.subscriptions.length > 0;
  const showGroupedView = groupedView && data.groups.length > 0;

  return (
    <PublicStatusFrame>
      <PublicStatusHeader
        data={data}
        showGroupToggle={showGroupToggle}
        grouped={groupedView}
        onToggleGrouped={() => setGroupedView((previous) => !previous)}
      />

      <div className="grid gap-8">
        <PublicStatusSummary data={data} />

        {vaultEnabled ? <PublicVaultRedeemCard token={normalizedToken} /> : null}

        {data.page.truncated ? (
          <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {t("publicStatus.truncated")}
          </div>
        ) : null}

        {data.subscriptions.length > 0 ? <PublicStatusUpcomingSection data={data} /> : null}

        {data.subscriptions.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <EyeOff className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-lg font-medium text-foreground">{t("publicStatus.emptyTitle")}</h2>
          </div>
        ) : showGroupedView ? (
          <PublicStatusGroupedViewSection
            data={data}
            requestableNames={requestableNames}
            onRequestAccess={setRequestTargetName}
          />
        ) : (
          <section className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]" aria-label={t("publicStatus.listLabel")}>
            {data.subscriptions.map((subscription, index) => (
              <div
                key={`${subscription.name}-${subscription.startDate ?? "unknown"}-${subscription.nextBillingDate}-${index}`}
                className="h-full animate-fade-in"
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <PublicSubscriptionCard
                  subscription={subscription}
                  onRequestAccess={requestableNames.has(subscription.name)
                    ? () => setRequestTargetName(subscription.name)
                    : undefined}
                />
              </div>
            ))}
          </section>
        )}

        {requestTargetName !== null ? (
          <PublicVaultRequestDialog
            token={normalizedToken}
            vault={data.vault}
            targetName={requestTargetName}
            onClose={() => setRequestTargetName(null)}
          />
        ) : null}
      </div>
    </PublicStatusFrame>
  );
}
