import type {
  BillingCycle,
  CustomCycleUnit,
  SubscriptionCollectionItem,
} from "@/types/subscription";
import type { DateOnly } from "@/lib/time/date-only";

type SubscriptionCycleKeys =
  | "billingCycle"
  | "customDays"
  | "customCycleUnit"
  | "oneTimeTermCount"
  | "oneTimeTermUnit"
  | "usageUnit"
  | "usageTotal"
  | "usageDailyRate"
  | "usageExpiresAt";

type RecurringBillingCycle = Exclude<BillingCycle, "custom" | "one-time" | "usage-based">;

export type SubscriptionCycleFixtureOverrides =
  | {
      billingCycle?: RecurringBillingCycle;
      customDays?: never;
      customCycleUnit?: never;
      oneTimeTermCount?: never;
      oneTimeTermUnit?: never;
      usageUnit?: never;
      usageTotal?: never;
      usageDailyRate?: never;
      usageExpiresAt?: never;
    }
  | {
      billingCycle: "custom";
      customDays?: number;
      customCycleUnit?: CustomCycleUnit;
      oneTimeTermCount?: never;
      oneTimeTermUnit?: never;
      usageUnit?: never;
      usageTotal?: never;
      usageDailyRate?: never;
      usageExpiresAt?: never;
    }
  | {
      billingCycle: "one-time";
      customDays?: never;
      customCycleUnit?: never;
      oneTimeTermCount?: never;
      oneTimeTermUnit?: never;
      usageUnit?: never;
      usageTotal?: never;
      usageDailyRate?: never;
      usageExpiresAt?: never;
    }
  | {
      billingCycle: "one-time";
      customDays?: never;
      customCycleUnit?: never;
      oneTimeTermCount: number;
      oneTimeTermUnit: CustomCycleUnit;
      usageUnit?: never;
      usageTotal?: never;
      usageDailyRate?: never;
      usageExpiresAt?: never;
    }
  | {
      billingCycle: "usage-based";
      customDays?: never;
      customCycleUnit?: never;
      oneTimeTermCount?: never;
      oneTimeTermUnit?: never;
      usageUnit?: string;
      usageTotal: number;
      usageDailyRate: number;
      usageExpiresAt?: DateOnly | null;
    };

export type SubscriptionFixtureOverrides<T extends SubscriptionCollectionItem> =
  Partial<Omit<T, SubscriptionCycleKeys>> & SubscriptionCycleFixtureOverrides;

type SubscriptionCycleFixture =
  | {
      billingCycle: RecurringBillingCycle;
      customDays: undefined;
      customCycleUnit: undefined;
      oneTimeTermCount: undefined;
      oneTimeTermUnit: undefined;
      usageUnit: undefined;
      usageTotal: undefined;
      usageDailyRate: undefined;
      usageExpiresAt: undefined;
    }
  | {
      billingCycle: "custom";
      customDays: number;
      customCycleUnit: CustomCycleUnit;
      oneTimeTermCount: undefined;
      oneTimeTermUnit: undefined;
      usageUnit: undefined;
      usageTotal: undefined;
      usageDailyRate: undefined;
      usageExpiresAt: undefined;
    }
  | {
      billingCycle: "one-time";
      customDays: undefined;
      customCycleUnit: undefined;
      oneTimeTermCount: undefined;
      oneTimeTermUnit: undefined;
      usageUnit: undefined;
      usageTotal: undefined;
      usageDailyRate: undefined;
      usageExpiresAt: undefined;
    }
  | {
      billingCycle: "one-time";
      customDays: undefined;
      customCycleUnit: undefined;
      oneTimeTermCount: number;
      oneTimeTermUnit: CustomCycleUnit;
      usageUnit: undefined;
      usageTotal: undefined;
      usageDailyRate: undefined;
      usageExpiresAt: undefined;
    }
  | {
      billingCycle: "usage-based";
      customDays: undefined;
      customCycleUnit: undefined;
      oneTimeTermCount: undefined;
      oneTimeTermUnit: undefined;
      usageUnit: string;
      usageTotal: number;
      usageDailyRate: number;
      usageExpiresAt: DateOnly | null;
    };

export function subscriptionCycleFixture(
  overrides: SubscriptionCycleFixtureOverrides = {},
): SubscriptionCycleFixture {
  if (overrides.billingCycle === "custom") {
    return {
      billingCycle: "custom",
      customDays: overrides.customDays ?? 30,
      customCycleUnit: overrides.customCycleUnit ?? "day",
      oneTimeTermCount: undefined,
      oneTimeTermUnit: undefined,
      usageUnit: undefined,
      usageTotal: undefined,
      usageDailyRate: undefined,
      usageExpiresAt: undefined,
    };
  }
  if (overrides.billingCycle === "one-time") {
    if (typeof overrides.oneTimeTermCount === "number" && overrides.oneTimeTermUnit) {
      return {
        billingCycle: "one-time",
        customDays: undefined,
        customCycleUnit: undefined,
        oneTimeTermCount: overrides.oneTimeTermCount,
        oneTimeTermUnit: overrides.oneTimeTermUnit,
        usageUnit: undefined,
        usageTotal: undefined,
        usageDailyRate: undefined,
        usageExpiresAt: undefined,
      };
    }
    return {
      billingCycle: "one-time",
      customDays: undefined,
      customCycleUnit: undefined,
      oneTimeTermCount: undefined,
      oneTimeTermUnit: undefined,
      usageUnit: undefined,
      usageTotal: undefined,
      usageDailyRate: undefined,
      usageExpiresAt: undefined,
    };
  }
  if (overrides.billingCycle === "usage-based") {
    return {
      billingCycle: "usage-based",
      customDays: undefined,
      customCycleUnit: undefined,
      oneTimeTermCount: undefined,
      oneTimeTermUnit: undefined,
      usageUnit: overrides.usageUnit ?? "条",
      usageTotal: overrides.usageTotal,
      usageDailyRate: overrides.usageDailyRate,
      usageExpiresAt: overrides.usageExpiresAt ?? null,
    };
  }
  return {
    billingCycle: overrides.billingCycle ?? "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    oneTimeTermCount: undefined,
    oneTimeTermUnit: undefined,
    usageUnit: undefined,
    usageTotal: undefined,
    usageDailyRate: undefined,
    usageExpiresAt: undefined,
  };
}
