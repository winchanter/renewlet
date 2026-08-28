/**
 * 订阅详情弹窗。
 *
 * 架构位置：列表、仪表盘和日历共用这一份只读详情，编辑仍交回页面级 CRUD 控制器。
 * 注意：金额、周期、状态和提醒标签必须继续复用订阅 domain 常量，避免不同入口展示口径分叉。
 */
import { useState, type ReactNode } from "react";
import { CalendarPlus, Edit2, ExternalLink, RotateCw } from "lucide-react";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import {
  DEFAULT_NOTIFICATION_REMINDER_DAYS,
  DISABLED_REMINDER_DAYS,
  INHERIT_REMINDER_DAYS,
} from "@/types/subscription";
import { AddToCalendarDialog } from "@/components/add-to-calendar-dialog";
import { preloadRenewSubscriptionDialog } from "@/components/renew-subscription-dialog-loader";
import { SubscriptionLogo } from "@/components/subscription-logo";
import {
  createSubscriptionDetailLoadingSlots,
  SubscriptionDetailScaffold,
  type SubscriptionDetailLoadingStructure,
} from "@/components/subscription-detail-scaffold";
import { SubscriptionStatusBadge } from "@/components/subscription-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MobileBottomDrawerContent, MobileDrawerRoot } from "@/components/ui/mobile-drawer";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useSettings } from "@/hooks/use-settings";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";
import { formatCompactCurrencyAmount } from "@/lib/currency";
import type { DateOnly } from "@/lib/time/date-only";
import {
  formatBillingCycleLabel,
  isOneTimeBuyout,
  isOneTimeFixedTerm,
  toDailyAmountFromMonthly,
  toSubscriptionMonthlyAmount,
} from "@/lib/subscription-billing";
import {
  getSubscriptionPriceReference,
  type SubscriptionCurrencyConverter,
} from "@/modules/subscriptions/domain/subscription-price-reference";
import { getEffectiveSubscriptionStatus } from "@/modules/subscriptions/domain/subscription-status";
import { isManualRenewEligible } from "@renewlet/shared/subscription-renewal";
import { calculateCostSharingSummary } from "@renewlet/shared/cost-sharing";

const DEFAULT_LOGO_FALLBACK_COLOR = "hsl(var(--primary))";

interface SubscriptionDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: Subscription | null;
  loadingPreview: SubscriptionCollectionItem | null;
  onEditSubscription?: (subscription: Subscription) => void;
  onRenewSubscription?: (id: string) => void;
  today: DateOnly | string;
  currencyConvert: SubscriptionCurrencyConverter;
  currencyRatesReady: boolean;
  priceReferenceCurrency: string | null;
  loading?: boolean | undefined;
}

interface SubscriptionDetailContentProps {
  subscription: Subscription | null;
  loading: boolean;
  loadingPreview: SubscriptionCollectionItem | null;
  today: DateOnly | string;
  onClose: () => void;
  onEditSubscription?: (subscription: Subscription) => void;
  onRenewSubscription?: (id: string) => void;
  onAddToCalendar: () => void;
  currencyConvert: SubscriptionCurrencyConverter;
  currencyRatesReady: boolean;
  priceReferenceCurrency: string | null;
}

function DetailRow({
  label,
  children,
  alignStart = false,
}: {
  label: string;
  children: ReactNode;
  alignStart?: boolean;
}) {
  return (
    <div className={cn("grid gap-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]", alignStart ? "items-start" : "items-center")}>
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-foreground sm:text-right">{children}</div>
    </div>
  );
}

function resolveDetailLoadingStructure(
  preview: SubscriptionCollectionItem | null,
): SubscriptionDetailLoadingStructure {
  const buyout = preview?.billingCycle === "one-time"
    && !("oneTimeTermCount" in preview && typeof preview.oneTimeTermCount === "number");
  return {
    showCalendarAction: preview !== null && !buyout,
    showCostSharing: preview?.costSharing?.enabled === true,
    showDailyAverage: preview !== null && !buyout,
    showNextBillingDate: preview !== null && (!buyout || preview.startDate !== null),
    showPaymentMethod: Boolean(preview?.paymentMethod),
    showStartDate: preview?.startDate !== null && preview?.startDate !== undefined,
    showTrialEndDate: preview?.trialEndDate !== undefined,
  };
}

function SubscriptionDetailContent({
  subscription,
  loading,
  loadingPreview,
  today,
  onClose,
  onEditSubscription,
  onRenewSubscription,
  onAddToCalendar,
  currencyConvert,
  currencyRatesReady,
  priceReferenceCurrency,
}: SubscriptionDetailContentProps) {
  const { config } = useCustomConfigState();
  const { data: settings } = useSettings();
  const { t, locale, label, formatDateOnly, formatCurrency } = useI18n();
  if (loading) {
    const loadingSlots = createSubscriptionDetailLoadingSlots({
      structure: resolveDetailLoadingStructure(loadingPreview),
      canEdit: Boolean(onEditSubscription),
      canRenew: Boolean(
        loadingPreview
        && onRenewSubscription
        && isManualRenewEligible(loadingPreview),
      ),
      label: t("common.loading"),
    });
    return (
      <SubscriptionDetailScaffold
        {...loadingSlots}
        className="min-h-96 content-start"
        data-testid="subscription-detail-data-loading"
      />
    );
  }
  if (!subscription) return null;

  const category = config.categories.find((item) => item.value === subscription.category);
  const paymentMethod = subscription.paymentMethod
    ? config.paymentMethods.find((item) => item.value === subscription.paymentMethod)
    : undefined;
  const categoryColor = category?.color ?? DEFAULT_LOGO_FALLBACK_COLOR;
  const effectiveStatus = getEffectiveSubscriptionStatus(subscription, today);
  const inheritedReminderDays = settings?.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const isBuyout = isOneTimeBuyout(subscription);
  const isFixedTermOneTime = isOneTimeFixedTerm(subscription);
  const isOneTime = subscription.billingCycle === "one-time";
  const isUsageBased = subscription.billingCycle === "usage-based";
  const dailyAmount = isBuyout
    ? null
    : toDailyAmountFromMonthly(toSubscriptionMonthlyAmount(subscription.price, subscription));
  const canManualRenew = Boolean(onRenewSubscription) && isManualRenewEligible(subscription);
  const costSharingSummary = calculateCostSharingSummary(subscription.costSharing, subscription.price, {
    baseCurrency: subscription.currency,
    convert: currencyConvert,
  });
  const priceReference = getSubscriptionPriceReference({
    price: subscription.price,
    currency: subscription.currency,
    targetCurrency: priceReferenceCurrency,
    currencyRatesReady,
    currencyConvert,
  });
  const priceReferenceLabel = priceReference === null
    ? null
    : t("subscription.priceReference", {
        amount: formatCurrency(priceReference.amount, priceReference.currency),
      });
  const renewalLabel = isOneTime
    ? t("subscription.renewal.oneTime")
    : subscription.autoRenew
      ? t("subscription.renewal.auto")
      : t("subscription.renewal.manual");
  const nextBillingLabel =
    isBuyout
      ? t("subscription.detail.purchaseDate")
      : isFixedTermOneTime || isUsageBased
        ? t("subscription.detail.expiryDate")
      : t("subscription.detail.nextBilling");
  const reminderLabel = subscription.reminderDays === DISABLED_REMINDER_DAYS
    ? t("subscription.card.reminderDisabled")
    : subscription.reminderDays === INHERIT_REMINDER_DAYS
      ? t("subscription.card.reminderInherit", { days: inheritedReminderDays })
      : t("reminder.days", { days: subscription.reminderDays });

  const handleEdit = () => {
    if (!onEditSubscription) return;
    // 详情和编辑都是 modal；先关详情再交给页面打开编辑，避免两个焦点陷阱同时存在。
    onClose();
    onEditSubscription(subscription);
  };

  return (
    <SubscriptionDetailScaffold
      identity={(
        <>
          <SubscriptionLogo
            name={subscription.name}
            logo={subscription.logo}
            fallbackColor={categoryColor}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold text-foreground">{subscription.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {category ? label(category.labels) : subscription.category}
            </p>
          </div>
        </>
      )}
      summary={(
        <>
          <div className="min-w-0">
            <p className="truncate text-2xl font-bold text-foreground">
              {formatCurrency(subscription.price, subscription.currency)}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatBillingCycleLabel(subscription, locale)}
            </p>
            {priceReferenceLabel ? (
              <p className="truncate text-xs tabular-nums text-muted-foreground">
                {priceReferenceLabel}
              </p>
            ) : null}
          </div>
          <SubscriptionStatusBadge status={effectiveStatus} />
        </>
      )}
      facts={(
        <>
          {dailyAmount !== null ? (
            <DetailRow label={t("subscription.detail.dailyAverage")}>
              <span className="tabular-nums">
                {formatCompactCurrencyAmount(dailyAmount, subscription.currency, locale)}
              </span>
            </DetailRow>
          ) : null}
          {costSharingSummary.enabled ? (
            <div className="grid gap-2 rounded-lg border border-border bg-secondary/40 p-3">
              <DetailRow label={t("subscription.field.price")}>
                <span className="font-semibold">{formatCurrency(costSharingSummary.total, subscription.currency)}</span>
              </DetailRow>
              <DetailRow label={t("subscription.costSharing.memberTotal")}>
                <span className="font-semibold text-warning">{formatCurrency(costSharingSummary.memberTotal, subscription.currency)}</span>
              </DetailRow>
              <DetailRow label={t("subscription.costSharing.yourShare")}>
                <span className="font-semibold text-primary">{formatCurrency(costSharingSummary.yourShare, subscription.currency)}</span>
              </DetailRow>
              <DetailRow label={t("subscription.costSharing.recoverableAmount")}>
                <span className="font-semibold">{formatCurrency(costSharingSummary.recoverableAmount, subscription.currency)}</span>
              </DetailRow>
            </div>
          ) : null}
          <DetailRow label={t("subscription.detail.category")}>
            <span className="wrap-break-word">{category ? label(category.labels) : subscription.category}</span>
          </DetailRow>
          {subscription.paymentMethod ? (
            <DetailRow label={t("subscription.field.paymentMethod")}>
              <span className="wrap-break-word">{paymentMethod ? label(paymentMethod.labels) : subscription.paymentMethod}</span>
            </DetailRow>
          ) : null}
          {isUsageBased && subscription.usageUnit && subscription.usageTotal != null && subscription.usageDailyRate != null ? (
            <DetailRow label={t("subscription.field.usagePackage")}>
              <span className="tabular-nums wrap-break-word">
                {t("subscription.detail.usageSummary", {
                  total: subscription.usageTotal.toLocaleString(locale),
                  unit: subscription.usageUnit,
                  dailyRate: subscription.usageDailyRate.toLocaleString(locale),
                })}
              </span>
            </DetailRow>
          ) : null}
          {isBuyout ? (
            subscription.startDate ? (
              <DetailRow label={nextBillingLabel}>
                {formatDateOnly(subscription.startDate, "full")}
              </DetailRow>
            ) : null
          ) : (
            <DetailRow label={nextBillingLabel}>
              {formatDateOnly(subscription.nextBillingDate, "full")}
            </DetailRow>
          )}
          {subscription.startDate ? (
            <DetailRow label={t("subscription.detail.startDate")}>
              {formatDateOnly(subscription.startDate, "full")}
            </DetailRow>
          ) : null}
          {subscription.trialEndDate ? (
            <DetailRow label={t("subscription.detail.trialEndDate")}>
              {formatDateOnly(subscription.trialEndDate, "full")}
            </DetailRow>
          ) : null}
          <DetailRow label={t("subscription.detail.reminder")}>
            {reminderLabel}
          </DetailRow>
          <DetailRow label={t("subscription.detail.renewalType")}>
            <Badge variant={isOneTime ? "secondary" : subscription.autoRenew ? "outline" : "secondary"} className="w-fit sm:ml-auto">
              {renewalLabel}
            </Badge>
          </DetailRow>
          <DetailRow label={t("subscription.detail.publicVisibility")}>
            <Badge variant={subscription.publicHidden ? "secondary" : "outline"} className="w-fit sm:ml-auto">
              {subscription.publicHidden ? t("subscription.publicVisibilityHidden") : t("subscription.publicVisibilityVisible")}
            </Badge>
          </DetailRow>
        </>
      )}
      extensions={(
        <>
          {subscription.tags.length > 0 ? (
            <DetailRow label={t("subscription.field.tags")} alignStart>
              <div className="flex flex-wrap gap-1 sm:justify-end">
                {subscription.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="max-w-full truncate text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </DetailRow>
          ) : null}
          {subscription.website ? (
            <DetailRow label={t("subscription.field.website")}>
              <a
                href={subscription.website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center justify-end gap-1 text-primary hover:underline"
              >
                <span className="truncate">{subscription.website}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </a>
            </DetailRow>
          ) : null}
          {subscription.notes ? (
            <div className="grid gap-2 border-t border-border pt-3">
              <p className="text-sm text-muted-foreground">{t("subscription.field.notes")}</p>
              <div className="max-h-48 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-border bg-secondary/40 p-3 text-sm leading-6 text-foreground">
                {subscription.notes}
              </div>
            </div>
          ) : null}
        </>
      )}
      actions={(
        <>
          <Button variant="outline" className="w-full justify-center border-border sm:w-auto" onClick={onClose}>
            {t("common.close")}
          </Button>
          {!isBuyout ? (
            <Button variant="outline" className="w-full justify-center border-border sm:w-auto" onClick={onAddToCalendar}>
              <CalendarPlus className="h-4 w-4" />
              {t("subscription.addToCalendar")}
            </Button>
          ) : null}
          {canManualRenew ? (
            <Button
              variant="outline"
              className="w-full justify-center border-border sm:w-auto"
              onPointerEnter={preloadRenewSubscriptionDialog}
              onFocus={preloadRenewSubscriptionDialog}
              onTouchStart={preloadRenewSubscriptionDialog}
              onClick={() => onRenewSubscription?.(subscription.id)}
            >
              <RotateCw className="h-4 w-4" />
              {t("subscription.renew")}
            </Button>
          ) : null}
          {onEditSubscription ? (
            <Button className="w-full justify-center bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto" onClick={handleEdit}>
              <Edit2 className="h-4 w-4" />
              {t("common.edit")}
            </Button>
          ) : null}
        </>
      )}
    />
  );
}

export function SubscriptionDetailDialog({
  open,
  onOpenChange,
  subscription,
  loadingPreview,
  onEditSubscription,
  onRenewSubscription,
  today,
  currencyConvert,
  currencyRatesReady,
  priceReferenceCurrency,
  loading,
}: SubscriptionDetailDialogProps) {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const { t } = useI18n();
  const [showAddToCalendarDialog, setShowAddToCalendarDialog] = useState(false);
  const [calendarSubscription, setCalendarSubscription] = useState<Subscription | null>(null);
  const titleSubscription = subscription ?? loadingPreview;
  const description = titleSubscription
    ? t("subscription.detailDescription", { name: titleSubscription.name })
    : t("subscription.detailFallbackDescription");
  const closeDetail = () => onOpenChange(false);
  const openAddToCalendar = () => {
    if (!subscription) return;
    // 添加到日历会先关闭详情；保留当前订阅快照，避免父级关闭动画清理 selected id 后子弹窗丢数据。
    setCalendarSubscription(subscription);
    setShowAddToCalendarDialog(true);
    closeDetail();
  };
  const handleAddToCalendarOpenChange = (nextOpen: boolean) => {
    setShowAddToCalendarDialog(nextOpen);
    if (!nextOpen) {
      setCalendarSubscription(null);
    }
  };
  const detailContent = loading || subscription ? (
    <SubscriptionDetailContent
      subscription={subscription}
      loading={loading === true}
      loadingPreview={loadingPreview}
      today={today}
      onClose={closeDetail}
      onAddToCalendar={openAddToCalendar}
      currencyConvert={currencyConvert}
      currencyRatesReady={currencyRatesReady}
      priceReferenceCurrency={priceReferenceCurrency}
      {...(onEditSubscription ? { onEditSubscription } : {})}
      {...(onRenewSubscription ? { onRenewSubscription } : {})}
    />
  ) : null;

  return (
    <>
      {isMobile ? (
        <MobileDrawerRoot open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
          {open ? (
            <MobileBottomDrawerContent
              title={titleSubscription?.name ?? t("subscription.detailFallbackTitle")}
              description={description}
              descriptionMode="sr-only"
              closeLabel={t("common.close")}
              className="max-h-[calc(var(--app-viewport-height)-1rem)]"
              aria-busy={loading ? true : undefined}
            >
              {detailContent}
            </MobileBottomDrawerContent>
          ) : null}
        </MobileDrawerRoot>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent
            className="max-h-[calc(var(--app-viewport-height)-3rem)] overflow-hidden border-border bg-card p-0 sm:max-w-lg"
            aria-busy={loading ? true : undefined}
          >
            <div className="grid min-h-0 gap-4 overflow-y-auto p-6">
              <DialogHeader>
                <DialogTitle className="sr-only">
                  {titleSubscription?.name ?? t("subscription.detailFallbackTitle")}
                </DialogTitle>
                <DialogDescription className="sr-only">{description}</DialogDescription>
              </DialogHeader>
              {detailContent}
            </div>
          </DialogContent>
        </Dialog>
      )}
      {showAddToCalendarDialog ? (
        <AddToCalendarDialog
          open={showAddToCalendarDialog}
          onOpenChange={handleAddToCalendarOpenChange}
          subscription={calendarSubscription}
          loadingPreview={calendarSubscription}
        />
      ) : null}
    </>
  );
}

export type { SubscriptionDetailDialogProps };
