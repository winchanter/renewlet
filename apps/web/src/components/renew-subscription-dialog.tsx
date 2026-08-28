import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, RefObject } from "react";
import { Loader2, History, ImagePlus, X } from "lucide-react";
import {
  createRenewSubscriptionLoadingSlots,
  RenewSubscriptionScaffold,
} from "@/components/renew-subscription-scaffold";
import { AuthorizedImage } from "@/components/authorized-image";
import { Button } from "@/components/ui/button";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumericInput } from "@/components/ui/numeric-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useI18n } from "@/i18n/I18nProvider";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useDeferredDialogInitialFocus } from "@/hooks/use-deferred-dialog-initial-focus";
import { buildPrivateAssetUrl, parsePrivateAssetId } from "@/lib/logo-url";
import { uploadImageFile } from "@/lib/upload-image";
import { compareDateOnly, type DateOnly } from "@/lib/time/date-only";
import { parseMoneyInput, parsePositiveNumberInput } from "@/lib/subscription-form";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import { advanceSubscriptionRenewal, calculateNextBillingDate, usageBasedEstimatedDays } from "@renewlet/shared/subscription-renewal";
import { RECEIPT_ASSET_IDS_MAX } from "@renewlet/shared/runtime";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";

type RenewMode = SubscriptionRenewBody["mode"];

interface RenewFormState {
  mode: RenewMode;
  price: string;
  currency: string;
  startDate: DateOnly | null;
  nextBillingDate: DateOnly;
  autoCalculateNextBillingDate: boolean;
  /** usage-based 续订（购买新量包）输入态：单位/总量/日均均为字符串，提交时转数字。 */
  usageUnit: string;
  usageTotal: string;
  usageDailyRate: string;
  /** 续订凭证 asset id 列表；上限 RECEIPT_ASSET_IDS_MAX。 */
  receiptAssetIds: string[];
}

interface RenewFormErrors {
  price?: string | undefined;
  currency?: string | undefined;
  startDate?: string | undefined;
  nextBillingDate?: string | undefined;
  usageTotal?: string | undefined;
  usageDailyRate?: string | undefined;
  usageUnit?: string | undefined;
}

export interface RenewSubscriptionDialogProps {
  subscription: Subscription | null;
  loadingPreview: SubscriptionCollectionItem | null;
  open: boolean;
  today: DateOnly;
  submitting: boolean;
  error?: string | null | undefined;
  restoreFocusRef?: RefObject<HTMLElement | null> | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: SubscriptionRenewBody) => Promise<void> | void;
  /** 查看历史记录入口由页面持有状态；续订弹窗只上抛订阅 id。 */
  onViewBillingRecords?: (id: string) => void;
  loading?: boolean | undefined;
}

/** usage 字段只存在于 usage-based 变体；周期推算入口统一从这里取，避免联合类型收窄散落各处。 */
function usageAnchorFields(subscription: Subscription): { usageTotal: number | undefined; usageDailyRate: number | undefined } {
  if (subscription.billingCycle !== "usage-based") {
    return { usageTotal: undefined, usageDailyRate: undefined };
  }
  return { usageTotal: subscription.usageTotal, usageDailyRate: subscription.usageDailyRate };
}

function defaultContinueNextBillingDate(subscription: Subscription, today: DateOnly): DateOnly {
  // continue 只能预览后端按原锚点会推进到哪里；用户在该模式下不能把日期当作新开始日提交。
  // 量包字段缺失或非法时退回当前耗尽日，避免弹窗初始化崩溃；提交时后端仍会校验。
  try {
    const result = advanceSubscriptionRenewal({
      billingCycle: subscription.billingCycle,
      status: subscription.status,
      startDate: subscription.startDate,
      nextBillingDate: subscription.nextBillingDate,
      autoRenew: subscription.autoRenew,
      autoCalculateNextBillingDate: subscription.autoCalculateNextBillingDate,
      customDays: subscription.customDays,
      customCycleUnit: subscription.customCycleUnit,
      ...usageAnchorFields(subscription),
    }, today, "manual");
    return result?.nextBillingDate as DateOnly | undefined ?? subscription.nextBillingDate;
  } catch {
    return subscription.nextBillingDate;
  }
}

function defaultRestartNextBillingDate(subscription: Subscription, startDate: DateOnly): DateOnly {
  const { usageTotal, usageDailyRate } = usageAnchorFields(subscription);
  try {
    return calculateNextBillingDate(
      startDate,
      subscription.billingCycle,
      subscription.customDays,
      undefined,
      subscription.customCycleUnit,
      usageTotal,
      usageDailyRate,
    ) as DateOnly;
  } catch {
    // 量包推算失败时以新开始日占位；提交后端会给出权威校验错误。
    return startDate;
  }
}

function createInitialState(subscription: Subscription, today: DateOnly): RenewFormState {
  const isUsageBased = subscription.billingCycle === "usage-based";
  // usage-based 没有继续/重新开始之分，续订即购买新量包，始终等同 restart。
  const mode: RenewMode = isUsageBased || subscription.status === "expired" ? "restart" : "continue";
  const state: RenewFormState = {
    mode,
    price: subscription.price,
    currency: subscription.currency,
    startDate: today,
    nextBillingDate: mode === "restart" ? defaultRestartNextBillingDate(subscription, today) : defaultContinueNextBillingDate(subscription, today),
    autoCalculateNextBillingDate: mode === "restart",
    usageUnit: "",
    usageTotal: "",
    usageDailyRate: "",
    receiptAssetIds: [],
  };
  if (isUsageBased) {
    // 预填原订阅的单位与日均（用户可修改），总量留空（新量包是新购买）。
    state.usageUnit = subscription.usageUnit ?? "";
    state.usageDailyRate = subscription.usageDailyRate != null ? String(subscription.usageDailyRate) : "";
  }
  return state;
}

function hasRenewBodyDates(value: SubscriptionRenewBody): value is SubscriptionRenewBody & { startDate: string } {
  return value.mode !== "restart" || typeof value.startDate === "string";
}

export function RenewSubscriptionDialogContent({
  subscription,
  open,
  today,
  submitting,
  error,
  onOpenChange,
  onSubmit,
  onViewBillingRecords,
  loading,
  loadingPreview,
}: RenewSubscriptionDialogProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const { config } = useCustomConfigState();
  const { t, locale, formatDateOnly } = useI18n();
  const [form, setForm] = useState<RenewFormState | null>(() => (
    open && subscription ? createInitialState(subscription, today) : null
  ));
  const [errors, setErrors] = useState<RenewFormErrors>({});
  const includeDisabledCurrent = form?.currency ?? subscription?.currency ?? null;
  const currencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    ...(includeDisabledCurrent ? { includeDisabledCurrent } : {}),
    locale,
  });

  useLayoutEffect(() => {
    if (!open || !subscription) return;
    setForm(createInitialState(subscription, today));
    setErrors({});
  }, [open, subscription, today]);

  const setField = useCallback(<K extends keyof RenewFormState>(key: K, value: RenewFormState[K]) => {
    setForm((current) => {
      if (!current) return current;
      const next = { ...current, [key]: value };
      // usage-based：总量/日均变化时，按当前购买日重新推算耗尽日。
      if (subscription?.billingCycle === "usage-based" && (key === "usageTotal" || key === "usageDailyRate")) {
        const startDate = next.startDate ?? today;
        const total = key === "usageTotal" ? value as string : next.usageTotal;
        const dailyRate = key === "usageDailyRate" ? value as string : next.usageDailyRate;
        const parsedTotal = parsePositiveNumberInput(total);
        const parsedRate = parsePositiveNumberInput(dailyRate);
        if (parsedTotal != null && parsedRate != null) {
          try {
            next.nextBillingDate = calculateNextBillingDate(startDate, "usage-based", undefined, undefined, undefined, parsedTotal, parsedRate) as DateOnly;
          } catch {
            // 推算失败（如日均过小），保留旧值；提交时由后端校验。
          }
        }
      }
      return next;
    });
    setErrors((current) => ({ ...current, [key]: undefined }));
  }, [subscription, today]);

  const switchMode = useCallback((mode: RenewMode) => {
    if (!subscription) return;
    setForm((current) => {
      const base = current ?? createInitialState(subscription, today);
      if (mode === "continue") {
        // continue 的日期只展示后端将采用的推进结果；restart 草稿日期不会进入该模式的提交 payload。
        return {
          ...base,
          mode,
          nextBillingDate: defaultContinueNextBillingDate(subscription, today),
          autoCalculateNextBillingDate: false,
        };
      }
      const startDate = base.startDate ?? today;
      return {
        ...base,
        mode,
        startDate,
        nextBillingDate: defaultRestartNextBillingDate(subscription, startDate),
        autoCalculateNextBillingDate: true,
      };
    });
    setErrors({});
  }, [subscription, today]);

  const handleRestartStartDateChange = useCallback((value: DateOnly | undefined) => {
    if (!subscription || !value) return;
    setForm((current) => {
      if (!current) return current;
      return {
        ...current,
        startDate: value,
        nextBillingDate: current.autoCalculateNextBillingDate ? defaultRestartNextBillingDate(subscription, value) : current.nextBillingDate,
      };
    });
    setErrors((current) => ({ ...current, startDate: undefined, nextBillingDate: undefined }));
  }, [subscription]);

  const handleNextBillingDateChange = useCallback((value: DateOnly | undefined) => {
    if (!value) return;
    setForm((current) => current ? {
      ...current,
      nextBillingDate: value,
      // restart 下手动改下次扣费日就是用户覆盖自动推算锚点，提交时必须保存这个选择。
      autoCalculateNextBillingDate: current.mode === "restart" ? false : current.autoCalculateNextBillingDate,
    } : current);
    setErrors((current) => ({ ...current, nextBillingDate: undefined }));
  }, []);

  const validate = useCallback((value: RenewFormState): RenewFormErrors => {
    const nextErrors: RenewFormErrors = {};
    if (parseMoneyInput(value.price) === null) {
      nextErrors.price = t("subscription.validation.amountInvalid");
    }
    if (!currencyOptions.some((option) => option.value === value.currency && option.disabled !== true)) {
      nextErrors.currency = t("subscription.renew.validation.currencyRequired");
    }
    if (value.mode === "restart" && !value.startDate) {
      nextErrors.startDate = t("subscription.renew.validation.startDateRequired");
    }
    if (value.mode === "restart" && value.startDate && compareDateOnly(value.nextBillingDate, value.startDate) < 0) {
      nextErrors.nextBillingDate = t("subscription.validation.dateOrderInvalid");
    }
    // usage-based 量包字段校验：总量必填且为正数；日均必填且为正数；单位沿用原订阅（只读），不需校验。
    if (subscription?.billingCycle === "usage-based") {
      if (parsePositiveNumberInput(value.usageTotal) === null) {
        nextErrors.usageTotal = t("subscription.validation.amountInvalid");
      }
      if (parsePositiveNumberInput(value.usageDailyRate) === null) {
        nextErrors.usageDailyRate = t("subscription.validation.amountInvalid");
      }
    }
    return nextErrors;
  }, [currencyOptions, subscription, t]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || submitting) return;
    const nextErrors = validate(form);
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      // 错误元素要等 React 提交 aria-invalid 后再查找；否则会把焦点留在提交按钮上。
      window.requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
      });
      return;
    }
    const price = parseMoneyInput(form.price);
    if (!price) return;
    const isUsageBasedRenew = subscription?.billingCycle === "usage-based";
    // usage-based 续订即购买新量包：提交前按新值重新推算耗尽日，保证 nextBillingDate 与总量/日均一致。
    let nextBillingDate = form.nextBillingDate;
    let usageTotal: number | undefined;
    let usageDailyRate: number | undefined;
    if (isUsageBasedRenew && form.startDate) {
      usageTotal = parsePositiveNumberInput(form.usageTotal) ?? undefined;
      usageDailyRate = parsePositiveNumberInput(form.usageDailyRate) ?? undefined;
      if (usageTotal != null && usageDailyRate != null) {
        try {
          nextBillingDate = calculateNextBillingDate(
            form.startDate,
            "usage-based",
            undefined,
            undefined,
            undefined,
            usageTotal,
            usageDailyRate,
          ) as DateOnly;
        } catch {
          // 推算失败（如日均过小导致天数超限），让后端给出权威错误。
        }
      }
    }
    const payload: SubscriptionRenewBody = {
      mode: form.mode,
      price,
      currency: form.currency,
      startDate: form.mode === "restart" ? form.startDate : null,
      nextBillingDate,
      autoCalculateNextBillingDate: form.mode === "restart" ? form.autoCalculateNextBillingDate : false,
      ...(isUsageBasedRenew ? { usageTotal, usageDailyRate } : {}),
      ...(form.receiptAssetIds.length > 0 ? { receiptAssetIds: form.receiptAssetIds } : {}),
    };
    if (!hasRenewBodyDates(payload)) return;
    await onSubmit(payload);
  };

  const titleSubscription = subscription ?? loadingPreview;
  const title = titleSubscription
    ? t("subscription.renew.title", { name: titleSubscription.name })
    : t("subscription.renew");
  const description = t("subscription.renew.description");
  const currentForm = form ?? (subscription ? createInitialState(subscription, today) : null);
  const isUsageBased = subscription?.billingCycle === "usage-based";
  const resolveInitialFocus = useCallback(
    () => formRef.current?.querySelector<HTMLElement>(
      isUsageBased
        ? '[name="renew-usage-total"]'
        : '[role="radio"][data-state="checked"]',
    ) ?? null,
    [isUsageBased],
  );
  useDeferredDialogInitialFocus(
    open,
    !loading && currentForm !== null,
    subscription?.id ?? "renew-subscription",
    resolveInitialFocus,
  );
  const restartMode = currentForm?.mode === "restart" || (currentForm === null && loadingPreview?.status === "expired");
  const submitLabel = isUsageBased
    ? t("subscription.renew.restartSubmit")
    : (restartMode ? t("subscription.renew.restartSubmit") : t("subscription.renew.submit"));
  const modeDescription = useMemo(() => {
    if (!currentForm) return "";
    if (isUsageBased) return t("subscription.renew.modeUsageBasedHelp");
    return currentForm.mode === "continue"
      ? t("subscription.renew.modeContinueHelp")
      : t("subscription.renew.modeRestartHelp");
  }, [currentForm, isUsageBased, t]);

  const handleViewBillingRecords = useCallback(() => {
    const id = subscription?.id ?? loadingPreview?.id;
    if (id) onViewBillingRecords?.(id);
  }, [loadingPreview?.id, onViewBillingRecords, subscription?.id]);

  const loadingSlots = loading
    ? createRenewSubscriptionLoadingSlots({ label: t("common.loading"), restartMode })
    : null;
  if (!loading && !currentForm) return null;

  return (
    <RenewSubscriptionScaffold
      formRef={formRef}
      onSubmit={submit}
      noValidate
      data-testid={loading ? "renew-subscription-data-loading" : undefined}
      heading={title}
      description={description}
      mode={loadingSlots?.mode ?? (currentForm ? (
        isUsageBased ? (
          <UsagePackageSection
            form={currentForm}
            errors={errors}
            onUsageTotalChange={(v) => setField("usageTotal", v)}
            onUsageUnitChange={(v) => setField("usageUnit", v)}
            onUsageDailyRateChange={(v) => setField("usageDailyRate", v)}
          />
        ) : (
          <FormField id="renew-mode" label={t("subscription.renew.mode")} description={modeDescription}>
            {(field) => (
              <RadioGroup
                value={currentForm.mode}
                onValueChange={(value) => switchMode(value as RenewMode)}
                aria-describedby={field.describedBy}
                className="grid gap-2 sm:grid-cols-2"
              >
                {(["continue", "restart"] as const).map((mode) => {
                  const optionId = `renew-mode-${mode}`;
                  return (
                    <label
                      key={mode}
                      htmlFor={optionId}
                      className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border border-border bg-secondary p-3 text-sm transition-colors hover:bg-accent"
                    >
                      <RadioGroupItem id={optionId} value={mode} className="mt-0.5 shrink-0" />
                      <span className="grid min-w-0 gap-1">
                        <span className="font-medium text-foreground">
                          {mode === "continue" ? t("subscription.renew.modeContinue") : t("subscription.renew.modeRestart")}
                        </span>
                        <span className="text-xs leading-relaxed text-muted-foreground">
                          {mode === "continue" ? t("subscription.renew.modeContinueShort") : t("subscription.renew.modeRestartShort")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
            )}
          </FormField>
        )
      ) : null)}
      pricing={loadingSlots?.pricing ?? (currentForm ? (
        <FormFieldRow
          alignAt="sm"
          rowClassName="sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)]"
          errors={[
            { id: "renew-price-error", message: errors.price },
            { id: "renew-currency-error", message: errors.currency },
          ]}
        >
          <FormField id="renew-price" label={t("subscription.field.price")} error={errors.price} renderError={false}>
            {(field) => (
              <NumericInput
                id={field.id}
                value={currentForm.price}
                onRawValueChange={(value) => setField("price", value)}
                decimalScale={6}
                allowNegative={false}
                thousandSeparator
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="h-11 border-border bg-secondary"
              />
            )}
          </FormField>
          <FormField id="renew-currency" label={t("subscription.field.currency")} error={errors.currency} renderError={false}>
            {(field) => (
              <SearchableSelect
                id={field.id}
                value={currentForm.currency}
                onValueChange={(value) => setField("currency", value)}
                options={currencyOptions}
                placeholder={t("subscription.placeholder.currency")}
                searchPlaceholder={t("subscription.search.currency")}
                emptyMessage={t("subscription.empty.currency")}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="h-11 border-border bg-secondary"
              />
            )}
          </FormField>
        </FormFieldRow>
      ) : null)}
      schedule={loadingSlots?.schedule ?? (currentForm ? (
        isUsageBased ? (
          <FormFieldRow
            alignAt="sm"
            rowClassName="sm:grid-cols-2"
            errors={[
              { id: "renew-start-date-error", message: errors.startDate },
              { id: "renew-next-billing-date-error", message: errors.nextBillingDate },
            ]}
          >
            <FormField
              id="renew-start-date"
              label={t("subscription.field.startDate")}
              labelId="renew-start-date-label"
              error={errors.startDate}
              renderError={false}
            >
              {(field) => (
                <DateOnlyPickerField
                  id={field.id}
                  labelId="renew-start-date-label"
                  valueId="renew-start-date-value"
                  value={currentForm.startDate ?? undefined}
                  onChange={handleRestartStartDateChange}
                  placeholder={t("subscription.placeholder.date")}
                  describedBy={field.describedBy}
                  invalid={field.invalid}
                  minDate={today}
                  defaultMonth={currentForm.startDate ?? today}
                  size="large"
                />
              )}
            </FormField>
            <FormField
              id="renew-next-billing-date"
              label={t("subscription.field.usageExhaustionDate")}
              labelId="renew-next-billing-date-label"
              description={t("subscription.usageExhaustionDateHelp")}
              renderError={false}
            >
              {() => (
                <DateOnlyPickerField
                  id="renew-next-billing-date"
                  labelId="renew-next-billing-date-label"
                  valueId="renew-next-billing-date-value"
                  value={currentForm.nextBillingDate}
                  onChange={() => { /* 耗尽日由总量/日均自动推算，不允许手动修改 */ }}
                  placeholder={t("subscription.placeholder.date")}
                  disabled
                  defaultMonth={currentForm.nextBillingDate}
                  size="large"
                />
              )}
            </FormField>
          </FormFieldRow>
        ) : restartMode ? (
            <FormFieldRow
              alignAt="sm"
              rowClassName="sm:grid-cols-2"
              errors={[
                { id: "renew-start-date-error", message: errors.startDate },
                { id: "renew-next-billing-date-error", message: errors.nextBillingDate },
              ]}
            >
              <FormField
                id="renew-start-date"
                label={t("subscription.field.startDate")}
                labelId="renew-start-date-label"
                error={errors.startDate}
                renderError={false}
              >
                {(field) => (
                  <DateOnlyPickerField
                    id={field.id}
                    labelId="renew-start-date-label"
                    valueId="renew-start-date-value"
                    value={currentForm.startDate ?? undefined}
                    onChange={handleRestartStartDateChange}
                    placeholder={t("subscription.placeholder.date")}
                    describedBy={field.describedBy}
                    invalid={field.invalid}
                    minDate={today}
                    defaultMonth={currentForm.startDate ?? today}
                    size="large"
                  />
                )}
              </FormField>
              <FormField
                id="renew-next-billing-date"
                label={t("subscription.field.nextBillingDate")}
                labelId="renew-next-billing-date-label"
                error={errors.nextBillingDate}
                renderError={false}
              >
                {(field) => (
                  <DateOnlyPickerField
                    id={field.id}
                    labelId="renew-next-billing-date-label"
                    valueId="renew-next-billing-date-value"
                    value={currentForm.nextBillingDate}
                    onChange={handleNextBillingDateChange}
                    placeholder={t("subscription.placeholder.date")}
                    describedBy={field.describedBy}
                    invalid={field.invalid}
                    minDate={currentForm.startDate ?? today}
                    defaultMonth={currentForm.nextBillingDate}
                    size="large"
                  />
                )}
              </FormField>
            </FormFieldRow>
          ) : (
            <div className="grid gap-3 rounded-md border border-border bg-secondary/40 p-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <p className="text-xs leading-5 text-muted-foreground">{t("subscription.renew.currentNextBillingDate")}</p>
                  <p className="font-medium text-foreground">{subscription ? formatDateOnly(subscription.nextBillingDate) : "-"}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs leading-5 text-muted-foreground">{t("subscription.renew.continueNextBillingDate")}</p>
                  <p className="font-medium text-foreground">{formatDateOnly(currentForm.nextBillingDate)}</p>
                </div>
              </div>
            </div>
          )
      ) : null)}
      extras={loadingSlots ? null : (currentForm ? (
        <ReceiptUploader
          value={currentForm.receiptAssetIds}
          onChange={(ids) => setField("receiptAssetIds", ids)}
          submitting={submitting}
        />
      ) : null)}
      actions={loadingSlots?.actions ?? (currentForm ? (
        <>
          {error ? (
            <p className="w-full min-w-0 wrap-break-word text-center text-sm text-destructive sm:mr-auto sm:w-auto sm:text-left">
              {error}
            </p>
          ) : null}
          {onViewBillingRecords ? (
            <Button
              type="button"
              variant="ghost"
              onClick={handleViewBillingRecords}
              disabled={submitting}
              className="w-full gap-1.5 text-muted-foreground hover:text-foreground sm:mr-auto sm:w-auto"
              data-testid="renew-view-billing-records"
            >
              <History className="h-4 w-4" />
              {t("subscription.billingRecords.viewHistory")}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="w-full border-border sm:w-auto" disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={submitting} className="w-full bg-primary text-primary-foreground hover:bg-primary-glow sm:w-auto">
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {submitLabel}
          </Button>
        </>
      ) : null)}
    />
  );
}

interface UsagePackageSectionProps {
  form: RenewFormState;
  errors: RenewFormErrors;
  onUsageTotalChange: (value: string) => void;
  onUsageUnitChange: (value: string) => void;
  onUsageDailyRateChange: (value: string) => void;
}

function UsagePackageSection({ form, errors, onUsageTotalChange, onUsageUnitChange, onUsageDailyRateChange }: UsagePackageSectionProps) {
  const { t } = useI18n();
  const total = parsePositiveNumberInput(form.usageTotal);
  const dailyRate = parsePositiveNumberInput(form.usageDailyRate);
  const estimatedDays = total != null && dailyRate != null ? safeUsageBasedEstimatedDays(total, dailyRate) : null;
  return (
    <div className="grid gap-4 rounded-lg border border-border bg-secondary/30 p-4" data-testid="renew-usage-package-section">
      <Label className="text-base font-medium">{t("subscription.field.usagePackage")}</Label>
      {estimatedDays !== null ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          {t("subscription.usageEstimatedDays", { days: estimatedDays })}
        </p>
      ) : null}
      <FormFieldRow
        alignAt="sm"
        rowClassName="sm:grid-cols-2"
        errors={[
          { id: "renew-usage-total-error", message: errors.usageTotal },
        ]}
      >
        <FormField
          id="renew-usage-total"
          label={t("subscription.field.usageTotal")}
          error={errors.usageTotal}
          errorId="renew-usage-total-error"
          renderError={false}
        >
          {(field) => (
            <NumericInput
              id={field.id}
              name="renew-usage-total"
              allowNegative={false}
              inputMode="decimal"
              enterKeyHint="next"
              placeholder={t("subscription.placeholder.usageTotal")}
              thousandSeparator
              value={form.usageTotal}
              onRawValueChange={onUsageTotalChange}
              aria-label={t("subscription.field.usageTotal")}
              aria-invalid={field.invalid}
              aria-describedby={field.describedBy}
              className="min-w-0 border-border bg-secondary"
            />
          )}
        </FormField>
        <FormField
          id="renew-usage-unit"
          label={t("subscription.field.usageUnit")}
          renderError={false}
        >
          {() => (
            <Input
              id="renew-usage-unit"
              name="renew-usage-unit"
              enterKeyHint="next"
              placeholder={t("subscription.placeholder.usageUnit")}
              value={form.usageUnit}
              onChange={(e) => onUsageUnitChange(e.target.value)}
              aria-label={t("subscription.field.usageUnit")}
              className="border-border bg-secondary"
            />
          )}
        </FormField>
      </FormFieldRow>
      <FormField
        id="renew-usage-daily-rate"
        label={t("subscription.field.usageDailyRate")}
        error={errors.usageDailyRate}
        errorId="renew-usage-daily-rate-error"
        renderError={false}
      >
        {(field) => (
          <NumericInput
            id={field.id}
            name="renew-usage-daily-rate"
            allowNegative={false}
            inputMode="decimal"
            enterKeyHint="next"
            placeholder={t("subscription.placeholder.usageDailyRate")}
            thousandSeparator
            value={form.usageDailyRate}
            onRawValueChange={onUsageDailyRateChange}
            aria-label={t("subscription.field.usageDailyRate")}
            aria-invalid={field.invalid}
            aria-describedby={field.describedBy}
            className="min-w-0 border-border bg-secondary"
          />
        )}
      </FormField>
    </div>
  );
}

function safeUsageBasedEstimatedDays(total: number, dailyRate: number): number | null {
  try {
    return usageBasedEstimatedDays(total, dailyRate);
  } catch {
    return null;
  }
}

interface ReceiptUploaderProps {
  value: string[];
  onChange: (ids: string[]) => void;
  submitting: boolean;
}

/**
 * 续订凭证多图上传区：可选，最多 RECEIPT_ASSET_IDS_MAX 张。
 *
 * 选图后顺序上传，每张成功即把 asset id 写回 form state；提交时整体随续订 payload 一起保存。
 * 取消续订时已上传但未提交的资产会留在用户资产池里，后续可手动清理，不影响本期记录。
 */
function ReceiptUploader({ value, onChange, submitting }: ReceiptUploaderProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const remaining = RECEIPT_ASSET_IDS_MAX - value.length;
  const canAddMore = remaining > 0 && uploadingCount === 0 && !submitting;

  const handleFiles = useCallback(async (files: File[]) => {
    // 只接受图片，非图片（如 PDF/zip）静默过滤；超出 remaining 的部分截断，不报错。
    const picked = files
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, remaining);
    if (picked.length === 0) return;
    setUploadError(null);
    setUploadingCount((current) => current + picked.length);
    try {
      const collected: string[] = [];
      for (const file of picked) {
        const result = await uploadImageFile({ file, kind: "receipt" });
        const id = parsePrivateAssetId(result.url);
        if (!id) {
          throw new Error(t("media.uploadFailed"));
        }
        collected.push(id);
      }
      onChange([...value, ...collected]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : t("media.uploadFailed"));
    } finally {
      setUploadingCount(0);
      // 清空 input.value，允许用户连续选同一文件重试。
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [onChange, remaining, t, value]);

  const removeAt = useCallback((index: number) => {
    setUploadError(null);
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
  }, [onChange, value]);

  // 整个上传区作为 dropzone：canAddMore=false 时静默忽略，避免提交中/上传中/已满被覆盖。
  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (canAddMore && !dragOver) setDragOver(true);
  }, [canAddMore, dragOver]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // relatedTarget 落在 dropzone 内部（如缩略图）时不清除高亮，避免在子元素间移动闪烁。
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (!canAddMore) return;
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    void handleFiles(dropped);
  }, [canAddMore, handleFiles]);

  return (
    <FormField
      id="renew-receipt"
      label={t("subscription.billingRecords.receipt")}
      description={t("subscription.billingRecords.receiptHint", { count: RECEIPT_ASSET_IDS_MAX })}
    >
      {() => (
        <div
          className={`grid gap-2 rounded-md border border-dashed p-1.5 transition-colors${
            dragOver
              ? " border-ring bg-secondary/30 ring-2 ring-ring/50"
              : " border-transparent"
          }`}
          data-testid="renew-receipt-uploader"
          data-drag-over={dragOver || undefined}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {value.length === 0 && uploadingCount === 0 ? (
            <p className="text-xs text-muted-foreground">{t("subscription.billingRecords.receiptDropHint")}</p>
          ) : null}
          {value.length > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="renew-receipt-list">
              {value.map((assetId, index) => (
                <li
                  key={assetId}
                  className="group relative aspect-square overflow-hidden rounded-md border border-border bg-secondary"
                >
                  <AuthorizedImage
                    src={buildPrivateAssetUrl(assetId)}
                    alt={t("subscription.billingRecords.receiptView", { index: index + 1 })}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <button
                    type="button"
                    onClick={() => removeAt(index)}
                    disabled={submitting}
                    aria-label={t("subscription.billingRecords.receiptRemove", { index: index + 1 })}
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 focus-visible:opacity-100"
                    data-testid={`renew-receipt-remove-${index}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
              {uploadingCount > 0 ? Array.from({ length: uploadingCount }).map((_, idx) => (
                <li
                  key={`renew-receipt-uploading-${idx}`}
                  className="flex aspect-square items-center justify-center rounded-md border border-dashed border-border bg-secondary/50"
                  aria-hidden="true"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </li>
              )) : null}
            </ul>
          ) : uploadingCount > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-hidden="true">
              {Array.from({ length: uploadingCount }).map((_, idx) => (
                <li
                  key={`renew-receipt-uploading-${idx}`}
                  className="flex aspect-square items-center justify-center rounded-md border border-dashed border-border bg-secondary/50"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </li>
              ))}
            </ul>
          ) : null}
          {canAddMore ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                onChange={(event) => {
                  if (event.target.files && event.target.files.length > 0) {
                    void handleFiles(Array.from(event.target.files));
                  }
                }}
                data-testid="renew-receipt-input"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-center border-border sm:w-auto"
                onClick={() => fileInputRef.current?.click()}
                data-testid="renew-receipt-add"
              >
                <ImagePlus className="mr-1.5 h-4 w-4" />
                {t("subscription.billingRecords.receiptAdd")}
              </Button>
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("subscription.billingRecords.receiptsLabel", { count: value.length, max: RECEIPT_ASSET_IDS_MAX })}
          </p>
          {uploadError ? (
            <p className="text-sm text-destructive" role="alert" data-testid="renew-receipt-error">
              {uploadError}
            </p>
          ) : null}
        </div>
      )}
    </FormField>
  );
}
