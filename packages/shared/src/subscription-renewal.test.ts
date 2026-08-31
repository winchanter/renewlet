// 续订算法测试读取共享 JSON fixture；同一批样例也由 Go 后端读取，用来锁住跨运行面账单日推进语义。
import { describe, expect, it } from "vitest";
import fixtures from "./subscription-renewal-fixtures.json";
import {
  advanceSubscriptionRenewal,
  calculateUsageBoundaryDate,
  calculateUsageExhaustionDate,
  isAutoRenewEligible,
  isManualRenewEligible,
  usageBasedAmortizationDays,
  usageBasedEstimatedDays,
  type RenewalMode,
  type SubscriptionRenewalInput,
} from "./subscription-renewal";

type Fixture = {
  name: string;
  input: SubscriptionRenewalInput;
  today: string;
  mode: RenewalMode;
  eligible: boolean;
  expectedNextBillingDate?: string;
  expectedStatus?: string;
};

describe("subscription renewal", () => {
  // 这份 fixture 同时被 Go 后端读取；新增续订规则时先扩展 fixture，再让两端实现追同一组期望。
  it.each(fixtures as Fixture[])("matches fixture $name", (fixture) => {
    const eligible = fixture.mode === "auto"
      ? isAutoRenewEligible(fixture.input, fixture.today)
      : isManualRenewEligible(fixture.input);
    expect(eligible).toBe(fixture.eligible);

    const result = advanceSubscriptionRenewal(fixture.input, fixture.today, fixture.mode);
    if (!fixture.eligible) {
      expect(result).toBeNull();
      return;
    }
    expect(result).toEqual({
      nextBillingDate: fixture.expectedNextBillingDate,
      status: fixture.expectedStatus,
    });
  });
});

describe("usage-based estimated days", () => {
  it.each([
    [1000, 10, 100],
    [1, 3, 1],
    [10, 3, 4],
    [1000, 0.5, 2000],
    [3_650_000, 1000, 3650],
  ])("estimates ceil($total / $rate) days", (total, rate, expected) => {
    expect(usageBasedEstimatedDays(total, rate)).toBe(expected);
  });

  it("rejects estimates beyond the maximum supported days", () => {
    // 1_000_000 ÷ 0.1 = 10_000_000 天：日均过小属于输入错误而不是无限期量包。
    expect(() => usageBasedEstimatedDays(1_000_000, 0.1)).toThrow("SUBSCRIPTION_USAGE_ESTIMATED_DAYS_TOO_HIGH");
  });

  it.each([
    [undefined, 10],
    [null, 10],
    [0, 10],
    [-5, 10],
    [Number.NaN, 10],
    [1000, undefined],
    [1000, null],
    [1000, 0],
    [1000, -1],
    [1000, Number.POSITIVE_INFINITY],
  ])("rejects total=$total rate=$rate", (total, rate) => {
    expect(() => usageBasedEstimatedDays(total, rate)).toThrow("SUBSCRIPTION_USAGE_FIELDS_INVALID");
  });
});

describe("usage-based exhaustion date", () => {
  it("adds the estimated days to the purchase date", () => {
    // 1000 条 ÷ 10 条/天 = 100 天：2026-01-01 + 100 天 = 2026-04-11。
    expect(calculateUsageExhaustionDate("2026-01-01", 1000, 10)).toBe("2026-04-11");
  });

  it("rounds fractional daily consumption up to whole days", () => {
    // 7 ÷ 2 = 3.5 → 4 天：2026-01-01 + 4 天 = 2026-01-05。
    expect(calculateUsageExhaustionDate("2026-01-01", 7, 2)).toBe("2026-01-05");
  });
});

describe("usage-based boundary date", () => {
  it("returns the exhaustion date when no expiry is set", () => {
    expect(calculateUsageBoundaryDate("2026-01-01", 1000, 10, null)).toBe("2026-04-11");
    expect(calculateUsageBoundaryDate("2026-01-01", 1000, 10, undefined)).toBe("2026-04-11");
  });

  it("returns the earlier expiry date when the pack expires before exhaustion", () => {
    // 100 天才耗尽，但量包 2026-02-01 失效：边界取失效日。
    expect(calculateUsageBoundaryDate("2026-01-01", 1000, 10, "2026-02-01")).toBe("2026-02-01");
  });

  it("returns the exhaustion date when it expires before the validity window", () => {
    expect(calculateUsageBoundaryDate("2026-01-01", 100, 10, "2026-06-01")).toBe("2026-01-11");
  });
});

describe("usage-based amortization days", () => {
  it("uses the estimated exhaustion days without expiry", () => {
    expect(usageBasedAmortizationDays(1000, 10, "2026-01-01", null)).toBe(100);
    expect(usageBasedAmortizationDays(1000, 10)).toBe(100);
  });

  it("clamps to the days before expiry when the validity window is shorter", () => {
    // 30 天有效期 < 100 天耗尽：按 30 天摊销。
    expect(usageBasedAmortizationDays(1000, 10, "2026-01-01", "2026-01-31")).toBe(30);
  });

  it("ignores an expiry later than exhaustion", () => {
    expect(usageBasedAmortizationDays(1000, 10, "2026-01-01", "2026-06-01")).toBe(100);
  });

  it("clamps an inverted date range to a single day", () => {
    expect(usageBasedAmortizationDays(1000, 10, "2026-01-01", "2025-12-31")).toBe(1);
  });
});
