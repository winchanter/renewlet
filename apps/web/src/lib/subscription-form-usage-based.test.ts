/**
 * usage-based 量包表单逻辑单测。
 *
 * 覆盖面：输入解析（parsePositiveNumberInput/parseUsageFormFields）、
 * 校验 issue（usageFieldsInvalid / 购买日必填）、提交边界（耗尽日推算与固定标志）。
 */
import { describe, expect, it } from "vitest";
import {
  getSubscriptionDateValidationKind,
  getSubscriptionFormValidationIssues,
  parsePositiveNumberInput,
  parseUsageFormFields,
  toSubscriptionFormSubmission,
} from "@/lib/subscription-form";
import { createSubscriptionFormState } from "@/types/subscription-form";

describe("parsePositiveNumberInput", () => {
  it.each([
    ["1000", 1000],
    ["0.5", 0.5],
    [" 12.5 ", 12.5],
  ])("accepts %s", (input, expected) => {
    expect(parsePositiveNumberInput(input)).toBe(expected);
  });

  it.each([
    [""],
    ["abc"],
    ["1e3"],
    ["01"],
    ["0"],
    ["-5"],
    ["1.2.3"],
    ["1000000001"],
  ])("rejects %s", (input) => {
    expect(parsePositiveNumberInput(input)).toBeNull();
  });
});

describe("parseUsageFormFields", () => {
  it("trims the unit and parses positive numbers", () => {
    expect(parseUsageFormFields(createSubscriptionFormState({
      billingCycle: "usage-based",
      usageUnit: " 短信条 ",
      usageTotal: "1000",
      usageDailyRate: "10",
    }))).toEqual({ unit: "短信条", total: 1000, dailyRate: 10 });
  });

  it("returns null when any field is missing or invalid", () => {
    expect(parseUsageFormFields(createSubscriptionFormState({
      billingCycle: "usage-based",
      usageUnit: "",
      usageTotal: "1000",
      usageDailyRate: "10",
    }))).toBeNull();
    expect(parseUsageFormFields(createSubscriptionFormState({
      billingCycle: "usage-based",
      usageUnit: "条",
      usageTotal: "",
      usageDailyRate: "10",
    }))).toBeNull();
    expect(parseUsageFormFields(createSubscriptionFormState({
      billingCycle: "usage-based",
      usageUnit: "条",
      usageTotal: "1000",
      usageDailyRate: "0",
    }))).toBeNull();
  });

  it("returns null when the estimated days exceed the limit", () => {
    // ceil(1_000_000 / 0.1) = 10_000_000 天，超过 shared 的 3650 天上限。
    expect(parseUsageFormFields(createSubscriptionFormState({
      billingCycle: "usage-based",
      usageUnit: "条",
      usageTotal: "1000000",
      usageDailyRate: "0.1",
    }))).toBeNull();
  });
});

describe("usage-based form validation", () => {
  const validUsageForm = createSubscriptionFormState({
    name: "短信量包",
    price: "50",
    billingCycle: "usage-based",
    usageUnit: "条",
    usageTotal: "1000",
    usageDailyRate: "10",
    startDate: "2026-01-01",
  });

  it("reports usageFieldsInvalid when package fields are incomplete", () => {
    const issues = getSubscriptionFormValidationIssues(createSubscriptionFormState({
      ...validUsageForm,
      usageDailyRate: "",
    }));
    expect(issues.map((issue) => issue.code)).toContain("usageFieldsInvalid");
    expect(issues.find((issue) => issue.code === "usageFieldsInvalid")?.field).toBe("usage");
  });

  it("reports purchaseDateRequired when the purchase date is missing", () => {
    expect(getSubscriptionDateValidationKind(createSubscriptionFormState({
      ...validUsageForm,
      startDate: undefined,
    }))).toBe("purchaseDateRequired");
  });

  it("does not require the exhaustion date input for usage-based forms", () => {
    expect(getSubscriptionDateValidationKind(validUsageForm)).toBeNull();
  });

  it("accepts a complete usage-based form without issues", () => {
    expect(getSubscriptionFormValidationIssues(validUsageForm)).toEqual([]);
  });
});

describe("usage-based form submission", () => {
  it("derives the exhaustion date and fixes renewal flags", () => {
    const submission = toSubscriptionFormSubmission(createSubscriptionFormState({
      name: "短信量包",
      price: "50",
      billingCycle: "usage-based",
      usageUnit: "条",
      usageTotal: "1000",
      usageDailyRate: "10",
      startDate: "2026-01-01",
      autoRenew: true,
      autoCalculate: false,
    }));
    expect(submission).toMatchObject({
      billingCycle: "usage-based",
      usageUnit: "条",
      usageTotal: 1000,
      usageDailyRate: 10,
      // 1000 ÷ 10 = 100 天：2026-01-01 + 100 天 = 2026-04-11。
      nextBillingDate: "2026-04-11",
      autoRenew: false,
      autoCalculateNextBillingDate: true,
    });
  });

  it("returns null when package fields are invalid", () => {
    expect(toSubscriptionFormSubmission(createSubscriptionFormState({
      name: "短信量包",
      price: "50",
      billingCycle: "usage-based",
      usageUnit: "条",
      usageTotal: "",
      usageDailyRate: "10",
      startDate: "2026-01-01",
    }))).toBeNull();
  });

  it("returns null when the purchase date is missing", () => {
    expect(toSubscriptionFormSubmission(createSubscriptionFormState({
      name: "短信量包",
      price: "50",
      billingCycle: "usage-based",
      usageUnit: "条",
      usageTotal: "1000",
      usageDailyRate: "10",
    }))).toBeNull();
  });
});
