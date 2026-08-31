import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { AuthorizedImage } from "@/components/authorized-image";
import { DateOnlyPickerField } from "@/components/date-only-picker-field";
import { QueryErrorState } from "@/components/query-error-state";
import { ReceiptUploader } from "@/components/receipt-uploader";
import { SubscriptionLogo } from "@/components/subscription-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField, FormFieldRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useCustomConfigState } from "@/contexts/CustomConfigContext";
import { useBillingRecords, useUpdateBillingRecord } from "@/hooks/use-billing-records";
import { useManagedCurrencyOptions } from "@/hooks/use-managed-currency-options";
import { useI18n } from "@/i18n/I18nProvider";
import { translate, type MessageKey, type MessageParams } from "@/i18n/messages";
import type { Locale } from "@/i18n/locales";
import { buildPrivateAssetUrl } from "@/lib/logo-url";
import { assetService } from "@/services/asset-service";
import { customCycleUnitLabelKey, formatBillingCycleLabel } from "@/lib/subscription-billing";
import { formatNumberMaxFractionDigits } from "@/lib/number-format";
import {
  parseMoneyInput,
  parseNonNegativeIntegerInput,
  parsePositiveNumberInput,
} from "@/lib/subscription-form";
import { assertDateOnly, compareDateOnly, type DateOnly } from "@/lib/time/date-only";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  CYCLE_LABELS,
  type ApiBillingRecord,
  type BillingCycle,
  type CustomCycleUnit,
  type SubscriptionCollectionItem,
} from "@/types/subscription";
import type { BillingRecordPatchBody } from "@renewlet/shared/schemas/billing-records";
import { moneyToNumber } from "@renewlet/shared/money";

export interface BillingRecordsDialogProps {
  /** 订阅列表快照：只用于头部 logo/名称展示，记录数据全部来自 billing-records 查询。 */
  collectionItem: SubscriptionCollectionItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ModeLabelKey = ApiBillingRecord["mode"];

/** mode 徽章：initial 是创建首期，auto 是 cron 推进，manual_* 是手动续订。 */
const MODE_LABEL_KEYS: Record<ModeLabelKey, MessageKey> = {
  initial: "subscription.billingRecords.modeInitial",
  auto: "subscription.billingRecords.modeAuto",
  manual_continue: "subscription.billingRecords.modeManual",
  manual_restart: "subscription.billingRecords.modeManual",
};

const MODE_BADGE_VARIANTS: Record<ModeLabelKey, "secondary" | "outline"> = {
  initial: "secondary",
  auto: "outline",
  manual_continue: "outline",
  manual_restart: "outline",
};

type TranslateFn = (key: MessageKey, params?: MessageParams) => string;

/** 记录行的周期描述：usage-based/带服务期的 one-time 有专属文案，其余复用订阅周期文案。 */
function formatRecordCycleLabel(
  record: ApiBillingRecord,
  locale: Locale,
  t: TranslateFn,
  formatDateOnly: (date: DateOnly | string) => string,
): string {
  if (record.billingCycle === "usage-based") {
    const parts = [
      t("subscription.billingRecords.usageCycle", {
        total: formatNumberMaxFractionDigits(record.usageTotal ?? 0),
        unit: record.usageUnit ?? "",
        dailyRate: formatNumberMaxFractionDigits(record.usageDailyRate ?? 0),
      }),
    ];
    // 结转余量/失效日是可选快照（旧记录无此字段）；仅在有值时补充展示。
    if (record.usageRemainingBefore != null && record.usageRemainingBefore > 0) {
      parts.push(t("subscription.billingRecords.usageRemaining", {
        remaining: formatNumberMaxFractionDigits(record.usageRemainingBefore),
        unit: record.usageUnit ?? "",
      }));
    }
    if (record.usageExpiresAt) {
      parts.push(t("subscription.billingRecords.usageExpiry", { date: formatDateOnly(record.usageExpiresAt) }));
    }
    return parts.join("，");
  }
  if (record.billingCycle === "one-time" && record.oneTimeTermCount != null && record.oneTimeTermUnit != null) {
    return t("subscription.billingRecords.termCycle", {
      count: record.oneTimeTermCount,
      unit: translate(locale, customCycleUnitLabelKey(record.oneTimeTermUnit)),
    });
  }
  return formatBillingCycleLabel({
    billingCycle: record.billingCycle,
    customDays: record.customDays ?? undefined,
    customCycleUnit: record.customCycleUnit ?? undefined,
  }, locale);
}

/** 历史记录弹窗内容：列表按扣费日倒序，行内展开编辑，分页按需加载。 */
export function BillingRecordsDialogContent({ collectionItem }: BillingRecordsDialogProps) {
  const { t, formatCurrency } = useI18n();
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const recordsQuery = useBillingRecords(collectionItem?.id ?? null, Boolean(collectionItem));
  const { records, total, hasNextPage } = recordsQuery;

  // 服务端游标按 (billingDate, id) 倒序返回；这里兜底排序，保证缓存重组后展示序稳定。
  const sortedRecords = useMemo(
    () => [...records].sort((a, b) =>
      compareDateOnly(b.billingDate, a.billingDate)
      || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    [records],
  );

  // 合计只在全部页加载完且币种一致时展示，避免分页未完时给出误导性的部分和。
  const totalAmountLabel = useMemo(() => {
    if (hasNextPage || sortedRecords.length === 0) return null;
    const first = sortedRecords[0];
    if (!first) return null;
    const currency = first.currency;
    if (!sortedRecords.every((record) => record.currency === currency)) return null;
    const sum = sortedRecords.reduce((accumulator, record) => accumulator + moneyToNumber(record.amount), 0);
    return t("subscription.billingRecords.metaTotal", { amount: formatCurrency(sum, currency) });
  }, [formatCurrency, hasNextPage, sortedRecords, t]);

  const toggleEdit = (recordId: string) => {
    setEditingRecordId((current) => (current === recordId ? null : recordId));
  };

  const subscriptionName = collectionItem?.name ?? "";

  return (
    <>
      <DialogHeader className="shrink-0 p-6 pb-0">
        <div className="flex min-w-0 items-center gap-3 pr-8">
          <SubscriptionLogo
            name={subscriptionName}
            logo={collectionItem?.logo}
            fallbackColor={collectionItem ? "hsl(var(--primary))" : undefined}
            size="sm"
          />
          <div className="grid min-w-0 gap-1">
            <DialogTitle className="text-xl font-semibold">{t("subscription.billingRecords.title")}</DialogTitle>
            <p className="truncate text-sm text-muted-foreground">{subscriptionName}</p>
          </div>
        </div>
        {recordsQuery.isPending ? (
          <Skeleton className="mt-2 h-4 w-40" />
        ) : (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="billing-records-meta">
            {t("subscription.billingRecords.metaCount", { count: total })}
            {totalAmountLabel ? ` · ${totalAmountLabel}` : null}
          </p>
        )}
      </DialogHeader>

      {/* 滚动区不用 flex-1：h-fit 面板在部分移动内核会把 flex-basis:0% 的子项内在高度按 0 计，导致弹窗塌成只剩 header；
          basis auto（默认）让内容高度计入面板 fit-content，超出时由 .h5-dialog-panel 的 max-height 收缩并滚动。 */}
      <div
        className="h5-mobile-sheet-scroll grid min-h-0 content-start gap-1 px-6 pb-6 pt-3"
        data-testid="billing-records-list-region"
      >
        {recordsQuery.isPending ? (
          <div className="grid gap-3 py-2" aria-hidden="true">
            {[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full" />)}
          </div>
        ) : recordsQuery.isError ? (
          <QueryErrorState error={recordsQuery.error} onRetry={() => void recordsQuery.refetch()} />
        ) : sortedRecords.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("subscription.billingRecords.empty")}</p>
        ) : (
          <ul className="grid" data-testid="billing-records-list">
            {sortedRecords.map((record) => (
              <BillingRecordRow
                key={record.id}
                record={record}
                editing={editingRecordId === record.id}
                onToggleEdit={toggleEdit}
              />
            ))}
          </ul>
        )}

        {recordsQuery.hasNextPage ? (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-32 border-border"
              disabled={recordsQuery.isFetchingNextPage}
              onClick={() => void recordsQuery.fetchNextPage()}
              data-testid="billing-records-load-more"
            >
              {recordsQuery.isFetchingNextPage
                ? t("common.loading")
                : t("subscription.billingRecords.loadMore", { loaded: sortedRecords.length, total })}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

interface BillingRecordRowProps {
  record: ApiBillingRecord;
  editing: boolean;
  onToggleEdit: (recordId: string) => void;
}

function BillingRecordRow({ record, editing, onToggleEdit }: BillingRecordRowProps) {
  const { t, locale, formatCurrency, formatDateOnly } = useI18n();
  const cycleLabel = useMemo(
    () => formatRecordCycleLabel(record, locale, t, formatDateOnly),
    [formatDateOnly, locale, record, t],
  );
  const periodText = record.periodEndDate
    ? `${formatDateOnly(record.billingDate)} → ${formatDateOnly(record.periodEndDate)}`
    : formatDateOnly(record.billingDate);

  return (
    <li className="grid gap-1 border-b border-border/60 py-3 last:border-b-0 sm:gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm tabular-nums text-foreground">{periodText}</span>
          <Badge
            variant={MODE_BADGE_VARIANTS[record.mode]}
            className="shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground"
            data-testid={`billing-record-mode-${record.id}`}
          >
            {t(MODE_LABEL_KEYS[record.mode])}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {formatCurrency(moneyToNumber(record.amount), record.currency)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label={t("common.edit")}
            aria-expanded={editing}
            onClick={() => onToggleEdit(record.id)}
            data-testid={`billing-record-edit-toggle-${record.id}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-w-0 whitespace-normal break-words text-xs leading-relaxed text-muted-foreground">
        {cycleLabel}
      </div>
      {!editing && record.receiptAssetIds.length > 0 ? (
        <BillingRecordReceipts record={record} />
      ) : null}
      {editing ? <BillingRecordEditForm record={record} onDone={() => onToggleEdit(record.id)} /> : null}
    </li>
  );
}

interface BillingRecordReceiptsProps {
  record: ApiBillingRecord;
}

/** 历史记录的续订凭证缩略图：点击在新标签打开私有资产读取路径。 */
function BillingRecordReceipts({ record }: BillingRecordReceiptsProps) {
  const { t } = useI18n();
  return (
    <ul
      className="grid grid-cols-4 gap-1.5 sm:grid-cols-6"
      data-testid={`billing-record-receipts-${record.id}`}
    >
      {record.receiptAssetIds.map((assetId, index) => (
        <li
          key={assetId}
          className="aspect-square overflow-hidden rounded border border-border bg-secondary"
        >
          <a
            href={buildPrivateAssetUrl(assetId)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("subscription.billingRecords.receiptView", { index: index + 1 })}
            className="block h-full w-full"
            data-testid={`billing-record-receipt-${record.id}-${index}`}
          >
            <AuthorizedImage
              src={buildPrivateAssetUrl(assetId)}
              alt={t("subscription.billingRecords.receiptView", { index: index + 1 })}
              className="h-full w-full object-cover transition-transform hover:scale-105"
              loading="lazy"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}

interface BillingRecordEditFormState {
  amount: string;
  currency: string;
  billingDate: DateOnly;
  billingCycle: BillingCycle;
  customDays: string;
  customCycleUnit: CustomCycleUnit;
  oneTimeTermCount: string;
  oneTimeTermUnit: CustomCycleUnit;
  usageTotal: string;
  usageDailyRate: string;
  /** 续订凭证 asset id 列表；与 ReceiptUploader 共用，PATCH 时整组覆盖。 */
  receiptAssetIds: string[];
}

interface BillingRecordEditFormErrors {
  amount?: string | undefined;
  customDays?: string | undefined;
  oneTimeTermCount?: string | undefined;
  usageTotal?: string | undefined;
  usageDailyRate?: string | undefined;
}

function createEditFormState(record: ApiBillingRecord): BillingRecordEditFormState {
  return {
    amount: record.amount,
    currency: record.currency,
    billingDate: assertDateOnly(record.billingDate),
    billingCycle: record.billingCycle,
    customDays: record.customDays != null ? String(record.customDays) : "",
    customCycleUnit: record.customCycleUnit ?? "day",
    oneTimeTermCount: record.oneTimeTermCount != null ? String(record.oneTimeTermCount) : "",
    oneTimeTermUnit: record.oneTimeTermUnit ?? "month",
    usageTotal: record.usageTotal != null ? String(record.usageTotal) : "",
    usageDailyRate: record.usageDailyRate != null ? String(record.usageDailyRate) : "",
    // 旧记录可能没有 receiptAssetIds，schema 已 default([])，这里取快照后即可独立编辑。
    receiptAssetIds: [...record.receiptAssetIds],
  };
}

/**
 * 编辑表单只提交用户改动过的字段；周期切换时必须整组提交条件字段，
 * 否则服务端的周期互斥校验会拿到半新半旧的快照。
 */
function buildBillingRecordPatch(
  record: ApiBillingRecord,
  state: BillingRecordEditFormState,
): { patch: BillingRecordPatchBody | null; errors: BillingRecordEditFormErrors } {
  const errors: BillingRecordEditFormErrors = {};
  const patch: BillingRecordPatchBody = {};

  const amount = parseMoneyInput(state.amount);
  if (amount === null) {
    errors.amount = "subscription.validation.amountInvalid";
  } else if (amount !== record.amount) {
    patch.amount = amount;
  }

  const currency = state.currency.trim().toUpperCase();
  if (currency !== record.currency) patch.currency = currency;

  if (state.billingDate !== record.billingDate) patch.billingDate = state.billingDate;

  const cycleChanged = state.billingCycle !== record.billingCycle;
  if (cycleChanged) patch.billingCycle = state.billingCycle;

  // 切换周期时必须显式清理不属于新周期的字段，
  // 否则服务端合并后旧字段残留，触发 billingRecordCycleIsConsistent 互斥校验失败。
  // usageUnit 在编辑表单里只读（沿用原订阅快照），切换离开 usage-based 时同步置空保持快照自洽。
  const clearOtherCycleFields = (keep: "custom" | "oneTime" | "usage" | "standard") => {
    if (keep !== "custom") {
      if (cycleChanged || record.customDays != null) patch.customDays = null;
      if (cycleChanged || record.customCycleUnit != null) patch.customCycleUnit = null;
    }
    if (keep !== "oneTime") {
      if (cycleChanged || record.oneTimeTermCount != null) patch.oneTimeTermCount = null;
      if (cycleChanged || record.oneTimeTermUnit != null) patch.oneTimeTermUnit = null;
    }
    if (keep !== "usage") {
      if (cycleChanged || record.usageUnit != null) patch.usageUnit = null;
      if (cycleChanged || record.usageTotal != null) patch.usageTotal = null;
      if (cycleChanged || record.usageDailyRate != null) patch.usageDailyRate = null;
    }
    // standard 周期（monthly/yearly/weekly/daily/quarterly/half-year）本身无专属字段，只需清空上面三组。
    void keep;
  };

  switch (state.billingCycle) {
    case "custom": {
      const days = parseNonNegativeIntegerInput(state.customDays);
      if (days === null || days <= 0) {
        errors.customDays = "subscription.validation.customCycleInvalid";
        break;
      }
      clearOtherCycleFields("custom");
      if (cycleChanged) {
        patch.customDays = days;
        patch.customCycleUnit = state.customCycleUnit;
      } else {
        if (days !== record.customDays) patch.customDays = days;
        if (state.customCycleUnit !== record.customCycleUnit) patch.customCycleUnit = state.customCycleUnit;
      }
      break;
    }
    case "one-time": {
      clearOtherCycleFields("oneTime");
      if (state.oneTimeTermCount === "") {
        // buyout 买断模式：term 计数/单位为空即无服务期，需要显式置 null 以覆盖原记录的 term 字段。
        if (record.oneTimeTermCount != null) patch.oneTimeTermCount = null;
        if (record.oneTimeTermUnit != null) patch.oneTimeTermUnit = null;
        break;
      }
      const count = parseNonNegativeIntegerInput(state.oneTimeTermCount);
      if (count === null || count <= 0) {
        errors.oneTimeTermCount = "subscription.validation.oneTimeTermInvalid";
        break;
      }
      if (cycleChanged) {
        patch.oneTimeTermCount = count;
        patch.oneTimeTermUnit = state.oneTimeTermUnit;
      } else {
        if (record.oneTimeTermCount == null || count !== record.oneTimeTermCount) patch.oneTimeTermCount = count;
        if (state.oneTimeTermUnit !== record.oneTimeTermUnit) patch.oneTimeTermUnit = state.oneTimeTermUnit;
      }
      break;
    }
    case "usage-based": {
      clearOtherCycleFields("usage");
      const usageTotal = parsePositiveNumberInput(state.usageTotal);
      const usageDailyRate = parsePositiveNumberInput(state.usageDailyRate);
      if (usageTotal === null) errors.usageTotal = "subscription.validation.amountInvalid";
      if (usageDailyRate === null) errors.usageDailyRate = "subscription.validation.amountInvalid";
      if (usageTotal === null || usageDailyRate === null) break;
      if (cycleChanged) {
        patch.usageTotal = usageTotal;
        patch.usageDailyRate = usageDailyRate;
      } else {
        if (usageTotal !== record.usageTotal) patch.usageTotal = usageTotal;
        if (usageDailyRate !== record.usageDailyRate) patch.usageDailyRate = usageDailyRate;
      }
      break;
    }
    default:
      // standard 周期：清空 custom / one-time / usage 三组专属字段。
      clearOtherCycleFields("standard");
      break;
  }

  // 凭证列表用整组覆盖：顺序或元素任一变化即写入 patch，避免对端做 diff。
  const receiptIdsChanged =
    state.receiptAssetIds.length !== record.receiptAssetIds.length
    || state.receiptAssetIds.some((id, index) => id !== record.receiptAssetIds[index]);
  if (receiptIdsChanged) patch.receiptAssetIds = state.receiptAssetIds;

  if (Object.keys(errors).length > 0) return { patch: null, errors };
  if (Object.keys(patch).length === 0) return { patch: null, errors };
  return { patch, errors };
}

interface BillingRecordEditFormProps {
  record: ApiBillingRecord;
  onDone: () => void;
}

function BillingRecordEditForm({ record, onDone }: BillingRecordEditFormProps) {
  const { t, locale, label } = useI18n();
  const { config } = useCustomConfigState();
  const currencyOptions = useManagedCurrencyOptions({
    currencies: config.currencies,
    includeDisabledCurrent: record.currency,
    locale,
  });
  const updateRecord = useUpdateBillingRecord();
  const [state, setState] = useState<BillingRecordEditFormState>(() => createEditFormState(record));
  const [errors, setErrors] = useState<BillingRecordEditFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 会话凭证清理：取消/换行编辑（卸载）时删除本次上传但未提交的凭证文件，避免孤儿占用存储。
  // savedRef 标记 PATCH 已成功（当前凭证已持久化）；persisted 集合在挂载时固化，不受列表 refetch 影响。
  const sessionRef = useRef({ saved: false, persisted: new Set(record.receiptAssetIds) });
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => () => {
    if (sessionRef.current.saved) return;
    for (const id of stateRef.current.receiptAssetIds) {
      if (!sessionRef.current.persisted.has(id)) {
        void assetService.delete(id).catch(() => {
          // 清理失败保留孤儿资产，不阻塞用户操作。
        });
      }
    }
  }, []);

  const setField = <K extends keyof BillingRecordEditFormState>(key: K, value: BillingRecordEditFormState[K]) => {
    setState((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setSubmitError(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (updateRecord.isPending) return;
    const { patch, errors: nextErrors } = buildBillingRecordPatch(record, state);
    // 校验错误需要走文案资源；patch 构建时先存 key，这里统一翻译。
    const translatedErrors = Object.fromEntries(
      Object.entries(nextErrors).map(([key, messageKey]) => [key, messageKey ? t(messageKey as MessageKey) : undefined]),
    ) as BillingRecordEditFormErrors;
    if (Object.values(translatedErrors).some(Boolean)) {
      setErrors(translatedErrors);
      return;
    }
    if (!patch) {
      // 没有任何改动：直接收起，不发起空 PATCH。
      sessionRef.current.saved = true;
      onDone();
      return;
    }
    try {
      await updateRecord.mutateAsync({ recordId: record.id, patch });
      sessionRef.current.saved = true;
      toast.success(t("subscription.billingRecords.updated"));
      onDone();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("error.generic"));
    }
  };

  const cycleOptions = useMemo(
    () => BILLING_CYCLES.map((value) => ({ value, label: label(CYCLE_LABELS[value]) })),
    [label],
  );
  const customCycleUnitOptions = useMemo(
    () => CUSTOM_CYCLE_UNITS.map((unit) => ({ value: unit, label: translate(locale, customCycleUnitLabelKey(unit)) })),
    [locale],
  );

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-1 grid gap-3 rounded-md border border-border bg-secondary/30 p-3">
      <FormFieldRow
        alignAt="sm"
        rowClassName="sm:grid-cols-2"
        errors={[{ id: `billing-record-amount-error-${record.id}`, message: errors.amount }]}
      >
        <FormField id={`billing-record-amount-${record.id}`} label={t("subscription.field.price")} error={errors.amount} renderError={false}>
          {(field) => (
            <NumericInput
              id={field.id}
              value={state.amount}
              onRawValueChange={(value) => setField("amount", value)}
              decimalScale={6}
              allowNegative={false}
              thousandSeparator
              aria-invalid={field.invalid}
              aria-describedby={field.describedBy}
              className="h-10 border-border bg-secondary"
            />
          )}
        </FormField>
        <FormField id={`billing-record-currency-${record.id}`} label={t("subscription.field.currency")}>
          {(field) => (
            <SearchableSelect
              id={field.id}
              value={state.currency}
              onValueChange={(value) => setField("currency", value)}
              options={currencyOptions}
              placeholder={t("subscription.placeholder.currency")}
              searchPlaceholder={t("subscription.search.currency")}
              emptyMessage={t("subscription.empty.currency")}
              className="h-10 border-border bg-secondary"
            />
          )}
        </FormField>
      </FormFieldRow>

      <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2">
        <FormField id={`billing-record-date-${record.id}`} label={t("subscription.billingRecords.billingDate")}>
          {() => (
            <DateOnlyPickerField
              id={`billing-record-date-${record.id}`}
              value={state.billingDate}
              onChange={(value) => {
                if (value) setField("billingDate", value);
              }}
              placeholder={t("subscription.placeholder.date")}
              defaultMonth={record.billingDate}
            />
          )}
        </FormField>
        <FormField id={`billing-record-cycle-${record.id}`} label={t("subscription.field.billingCycle")}>
          {(field) => (
            <Select value={state.billingCycle} onValueChange={(value) => setField("billingCycle", value as BillingCycle)}>
              <SelectTrigger id={field.id} className="h-10 border-border bg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cycleOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      </FormFieldRow>

      {state.billingCycle === "custom" ? (
        <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2" errors={[{ id: `billing-record-custom-days-error-${record.id}`, message: errors.customDays }]}>
          <FormField id={`billing-record-custom-days-${record.id}`} label={t("subscription.field.customDays")} error={errors.customDays} renderError={false}>
            {(field) => (
              <NumericInput
                id={field.id}
                value={state.customDays}
                onRawValueChange={(value) => setField("customDays", value)}
                decimalScale={0}
                allowNegative={false}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="h-10 border-border bg-secondary"
              />
            )}
          </FormField>
          <FormField id={`billing-record-custom-unit-${record.id}`} label={t("subscription.field.customCycleUnit")}>
            {() => (
              <Select
                value={state.customCycleUnit}
                onValueChange={(value) => setField("customCycleUnit", value as CustomCycleUnit)}
              >
                <SelectTrigger id={`billing-record-custom-unit-${record.id}`} className="h-10 border-border bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {customCycleUnitOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        </FormFieldRow>
      ) : null}

      {state.billingCycle === "one-time" ? (
        <FormFieldRow alignAt="sm" rowClassName="sm:grid-cols-2" errors={[{ id: `billing-record-term-error-${record.id}`, message: errors.oneTimeTermCount }]}>
          <FormField
            id={`billing-record-term-count-${record.id}`}
            label={t("subscription.field.oneTimeTerm")}
            error={errors.oneTimeTermCount}
            renderError={false}
          >
            {(field) => (
              <NumericInput
                id={field.id}
                value={state.oneTimeTermCount}
                onRawValueChange={(value) => setField("oneTimeTermCount", value)}
                decimalScale={0}
                allowNegative={false}
                placeholder={t("subscription.placeholder.date")}
                aria-invalid={field.invalid}
                aria-describedby={field.describedBy}
                className="h-10 border-border bg-secondary"
              />
            )}
          </FormField>
          <FormField id={`billing-record-term-unit-${record.id}`} label={t("subscription.field.oneTimeTermUnit")}>
            {() => (
              <Select
                value={state.oneTimeTermUnit}
                onValueChange={(value) => setField("oneTimeTermUnit", value as CustomCycleUnit)}
              >
                <SelectTrigger id={`billing-record-term-unit-${record.id}`} className="h-10 border-border bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {customCycleUnitOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        </FormFieldRow>
      ) : null}

      {state.billingCycle === "usage-based" ? (
        <>
          <FormFieldRow
            alignAt="sm"
            rowClassName="sm:grid-cols-2"
            errors={[
              { id: `billing-record-usage-total-error-${record.id}`, message: errors.usageTotal },
              { id: `billing-record-usage-rate-error-${record.id}`, message: errors.usageDailyRate },
            ]}
          >
            <FormField id={`billing-record-usage-total-${record.id}`} label={t("subscription.field.usageTotal")} error={errors.usageTotal} renderError={false}>
              {(field) => (
                <NumericInput
                  id={field.id}
                  value={state.usageTotal}
                  onRawValueChange={(value) => setField("usageTotal", value)}
                  allowNegative={false}
                  thousandSeparator
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  className="h-10 border-border bg-secondary"
                />
              )}
            </FormField>
            <FormField id={`billing-record-usage-rate-${record.id}`} label={t("subscription.field.usageDailyRate")} error={errors.usageDailyRate} renderError={false}>
              {(field) => (
                <NumericInput
                  id={field.id}
                  value={state.usageDailyRate}
                  onRawValueChange={(value) => setField("usageDailyRate", value)}
                  allowNegative={false}
                  thousandSeparator
                  aria-invalid={field.invalid}
                  aria-describedby={field.describedBy}
                  className="h-10 border-border bg-secondary"
                />
              )}
            </FormField>
          </FormFieldRow>
          <FormField id={`billing-record-usage-unit-${record.id}`} label={t("subscription.field.usageUnit")}>
            {() => (
              // usageUnit 只读沿用生成时的快照；PATCH 不开放该字段的自由修改。
              <Input
                id={`billing-record-usage-unit-${record.id}`}
                value={record.usageUnit ?? ""}
                readOnly
                disabled
                className="h-10 border-border bg-secondary opacity-60"
              />
            )}
          </FormField>
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("subscription.billingRecords.periodHint")}</p>

      <ReceiptUploader
        value={state.receiptAssetIds}
        onChange={(ids) => setField("receiptAssetIds", ids)}
        submitting={updateRecord.isPending}
        persistedIds={record.receiptAssetIds}
        testIdPrefix={`billing-record-receipt-${record.id}`}
      />
      {submitError ? (
        <p className="text-sm text-destructive" role="alert" data-testid={`billing-record-submit-error-${record.id}`}>
          {submitError}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" className="border-border" onClick={onDone} disabled={updateRecord.isPending}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={updateRecord.isPending}>
          {updateRecord.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
