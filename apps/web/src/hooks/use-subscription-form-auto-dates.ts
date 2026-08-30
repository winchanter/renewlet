import { useEffect, type Dispatch, type SetStateAction } from "react";
import { calculateNextBillingDate, calculateOneTimeTermEndDate, calculateUsageExhaustionDate } from "@/lib/subscription-billing";
import { parsePositiveIntegerInput, parseUsageFormFields } from "@/lib/subscription-form";
import type { DateOnly } from "@/lib/time/date-only";
import type { SubscriptionFormState } from "@/types/subscription-form";

type SubscriptionFormAutoDatePatch = Pick<Partial<SubscriptionFormState>, "autoCalculate" | "nextBillingDate" | "trialEndDate">;
type SubscriptionFormAutoDateFields = Pick<
  SubscriptionFormState,
  | "autoCalculate"
  | "billingCycle"
  | "customCycleUnit"
  | "customDays"
  | "nextBillingDate"
  | "oneTimeMode"
  | "oneTimeTermCount"
  | "oneTimeTermUnit"
  | "usageUnit"
  | "usageTotal"
  | "usageDailyRate"
  | "startDate"
  | "status"
  | "trialEndDate"
>;

export function useSubscriptionFormAutoDates(
  formData: SubscriptionFormState,
  setFormData: Dispatch<SetStateAction<SubscriptionFormState>>,
  billingReferenceDate: DateOnly,
  onAutoDatePatch?: (patch: SubscriptionFormAutoDatePatch) => void,
): void {
  const {
    autoCalculate,
    billingCycle,
    customCycleUnit,
    customDays,
    nextBillingDate,
    oneTimeMode,
    oneTimeTermCount,
    oneTimeTermUnit,
    usageUnit,
    usageTotal,
    usageDailyRate,
    startDate,
    status,
    trialEndDate,
  } = formData;

  useEffect(() => {
    // 这个 effect 只根据账单字段生成最小 patch；避免 setFormData 回写同值导致表单状态链反复触发。
    const patch = getSubscriptionFormAutoDatePatch({
      autoCalculate,
      billingCycle,
      customCycleUnit,
      customDays,
      nextBillingDate,
      oneTimeMode,
      oneTimeTermCount,
      oneTimeTermUnit,
      usageUnit,
      usageTotal,
      usageDailyRate,
      startDate,
      status,
      trialEndDate,
    }, billingReferenceDate);
    if (!patch) return;
    setFormData((prev) => ({ ...prev, ...patch }));
    onAutoDatePatch?.(patch);
  }, [
    autoCalculate,
    billingReferenceDate,
    billingCycle,
    customCycleUnit,
    customDays,
    nextBillingDate,
    onAutoDatePatch,
    oneTimeMode,
    oneTimeTermCount,
    oneTimeTermUnit,
    setFormData,
    startDate,
    status,
    trialEndDate,
    usageUnit,
    usageTotal,
    usageDailyRate,
  ]);
}

export function getSubscriptionFormAutoDatePatch(
  formData: SubscriptionFormAutoDateFields,
  billingReferenceDate: DateOnly,
): SubscriptionFormAutoDatePatch | null {
  if (formData.billingCycle === "one-time") {
    // 一次性固定服务期的到期日来自 startDate + term；买断/长期有效则保留 startDate 并关闭自动日期语义。
    const oneTimeTermCount = formData.oneTimeMode === "term" ? parsePositiveIntegerInput(formData.oneTimeTermCount) : null;
    const nextBillingDate = formData.startDate && oneTimeTermCount
      ? calculateOneTimeTermEndDate(formData.startDate, oneTimeTermCount, formData.oneTimeTermUnit)
      : formData.startDate;
    // 一次性 term 固定服务期模式下如果是试用态，同步试用到期日到服务期结束日；buyout 买断不联动试用。
    // 用户随后可独立微调试用到期日，反向不会被覆盖（effect 只在关键字段变化时触发）。
    return compactAutoDatePatch(formData, {
      autoCalculate: false,
      nextBillingDate,
      trialEndDate: formData.status === "trial" && formData.oneTimeMode === "term" ? nextBillingDate : formData.trialEndDate,
    });
  }
  if (formData.billingCycle === "usage-based") {
    // 量包耗尽日 = 购买日 + ceil(总量/日均)；字段未填全时保留 startDate，等量包校验给出首错。
    const usage = parseUsageFormFields(formData);
    const nextBillingDate = formData.startDate && usage
      ? calculateUsageExhaustionDate(formData.startDate, usage.total, usage.dailyRate)
      : formData.startDate;
    // 耗尽日始终自动推算；与 one-time 相同不联动试用到期日，量包的到期边界由消耗驱动。
    return compactAutoDatePatch(formData, {
      autoCalculate: false,
      nextBillingDate,
    });
  }
  if (formData.autoCalculate && formData.startDate) {
    // 自定义周期缺天数时沿用历史表单默认 30 天，保持手动输入为空时仍能给用户一个可预览日期。
    const customDays = formData.billingCycle === "custom" ? parsePositiveIntegerInput(formData.customDays) ?? 30 : undefined;
    const customCycleUnit = formData.billingCycle === "custom" ? formData.customCycleUnit : "day";
    const nextBillingDate = calculateNextBillingDate(formData.startDate, formData.billingCycle, customDays, billingReferenceDate, customCycleUnit);
    // 试用态下自动计算的到期日同步到试用到期日，保持与 update 分支单向同步口径一致；
    // 用户随后可独立微调试用到期日，反向不会被覆盖（autoCalculate 只跟随 startDate 触发）。
    return compactAutoDatePatch(formData, {
      nextBillingDate,
      trialEndDate: formData.status === "trial" ? nextBillingDate : formData.trialEndDate,
    });
  }
  return null;
}

function compactAutoDatePatch(
  formData: SubscriptionFormAutoDateFields,
  patch: SubscriptionFormAutoDatePatch,
): SubscriptionFormAutoDatePatch | null {
  const compacted: SubscriptionFormAutoDatePatch = {};
  if (patch.autoCalculate !== undefined && patch.autoCalculate !== formData.autoCalculate) {
    compacted.autoCalculate = patch.autoCalculate;
  }
  if (patch.nextBillingDate !== undefined && patch.nextBillingDate !== formData.nextBillingDate) {
    compacted.nextBillingDate = patch.nextBillingDate;
  }
  if (patch.trialEndDate !== undefined && patch.trialEndDate !== formData.trialEndDate) {
    compacted.trialEndDate = patch.trialEndDate;
  }
  return Object.keys(compacted).length > 0 ? compacted : null;
}
