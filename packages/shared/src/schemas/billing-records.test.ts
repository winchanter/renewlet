import { describe, expect, it } from "vitest";
import {
  apiBillingRecordSchema,
  billingRecordPatchBodySchema,
  billingRecordPatchTouchesPeriod,
  billingRecordsListQuerySchema,
  billingRecordsListResponseSchema,
  computeBillingRecordPeriodEnd,
  decodeBillingRecordCursor,
  encodeBillingRecordCursor,
} from "./billing-records";

function recurringRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec_1",
    subscriptionId: "sub_1",
    name: "Netflix",
    billingDate: "2026-09-01",
    periodEndDate: "2026-10-01",
    amount: "30.00",
    currency: "CNY",
    mode: "auto" as const,
    billingCycle: "monthly" as const,
    ...overrides,
  };
}

describe("apiBillingRecordSchema", () => {
  it("接受合法周期记录", () => {
    expect(apiBillingRecordSchema.parse(recurringRecord())).toBeTruthy();
  });

  it("接受无周期字段的 one-time 买断记录（periodEndDate 为空）", () => {
    const record = recurringRecord({
      billingCycle: "one-time",
      periodEndDate: null,
    });
    expect(apiBillingRecordSchema.parse(record)).toBeTruthy();
  });

  it("接受 one-time 固定服务期快照", () => {
    const record = recurringRecord({
      billingCycle: "one-time",
      periodEndDate: "2027-08-31",
      oneTimeTermCount: 12,
      oneTimeTermUnit: "month",
    });
    expect(apiBillingRecordSchema.parse(record)).toBeTruthy();
  });

  it("接受 usage-based 量包快照", () => {
    const record = recurringRecord({
      billingCycle: "usage-based",
      periodEndDate: "2026-12-01",
      usageUnit: "GB",
      usageTotal: 500,
      usageDailyRate: 2,
    });
    expect(apiBillingRecordSchema.parse(record)).toBeTruthy();
  });

  it("拒绝周期字段组合矛盾（monthly 带量包字段）", () => {
    const record = recurringRecord({ usageTotal: 500 });
    expect(() => apiBillingRecordSchema.parse(record)).toThrow();
  });

  it("拒绝 custom 周期缺失数量或单位", () => {
    expect(() => apiBillingRecordSchema.parse(recurringRecord({ billingCycle: "custom" }))).toThrow();
    expect(() => apiBillingRecordSchema.parse(recurringRecord({ billingCycle: "custom", customDays: 3 }))).toThrow();
  });

  it("拒绝到期日早于扣费日", () => {
    const record = recurringRecord({ periodEndDate: "2026-08-31" });
    expect(() => apiBillingRecordSchema.parse(record)).toThrow();
  });

  it("拒绝未知 mode 与非法日期", () => {
    expect(() => apiBillingRecordSchema.parse(recurringRecord({ mode: "manual" }))).toThrow();
    expect(() => apiBillingRecordSchema.parse(recurringRecord({ billingDate: "2026-09-01T00:00:00Z" }))).toThrow();
  });
});

describe("billingRecordPatchBodySchema", () => {
  it("接受部分事实修正字段", () => {
    // moneyStringSchema 会把金额规范化为 canonical 形式（去掉尾零）。
    expect(billingRecordPatchBodySchema.parse({ amount: "28.50" })).toEqual({ amount: "28.5" });
    expect(billingRecordPatchBodySchema.parse({ billingCycle: "usage-based", usageUnit: "GB", usageTotal: 100, usageDailyRate: 1 }))
      .toBeTruthy();
  });

  it("拒绝空 payload 与归属字段", () => {
    expect(() => billingRecordPatchBodySchema.parse({})).toThrow();
    expect(() => billingRecordPatchBodySchema.parse({ subscriptionId: "sub_2" })).toThrow();
    expect(() => billingRecordPatchBodySchema.parse({ mode: "auto" })).toThrow();
  });
});

describe("billingRecordPatchTouchesPeriod", () => {
  it("金额修正不触发到期日重算", () => {
    expect(billingRecordPatchTouchesPeriod({ amount: "28.00" })).toBe(false);
    expect(billingRecordPatchTouchesPeriod({ currency: "USD" })).toBe(false);
  });

  it("扣费日与周期变化触发重算", () => {
    expect(billingRecordPatchTouchesPeriod({ billingDate: "2026-09-02" })).toBe(true);
    expect(billingRecordPatchTouchesPeriod({ billingCycle: "annual" })).toBe(true);
    expect(billingRecordPatchTouchesPeriod({ usageTotal: 300 })).toBe(true);
  });
});

describe("computeBillingRecordPeriodEnd", () => {
  it("周期记录按扣费日 + 一期重算", () => {
    expect(computeBillingRecordPeriodEnd({
      billingDate: "2026-01-31",
      billingCycle: "monthly",
    })).toBe("2026-02-28");
  });

  it("量包按扣费日 + 预估可用天数重算", () => {
    expect(computeBillingRecordPeriodEnd({
      billingDate: "2026-09-01",
      billingCycle: "usage-based",
      usageTotal: 100,
      usageDailyRate: 2,
    })).toBe("2026-10-21");
  });

  it("one-time 买断没有到期日", () => {
    expect(computeBillingRecordPeriodEnd({ billingDate: "2026-09-01", billingCycle: "one-time" })).toBeNull();
  });
});

describe("billing records cursor", () => {
  it("编码与解码往返一致", () => {
    const cursor = encodeBillingRecordCursor({ billingDate: "2026-09-01", id: "rec_abc" });
    expect(decodeBillingRecordCursor(cursor)).toEqual({ billingDate: "2026-09-01", id: "rec_abc" });
  });

  it("拒绝非法游标", () => {
    expect(decodeBillingRecordCursor("not-a-cursor")).toBeNull();
    expect(decodeBillingRecordCursor("2026-13-01~rec_1")).toBeNull();
    expect(decodeBillingRecordCursor("2026-09-01~")).toBeNull();
  });
});

describe("billingRecordsListQuerySchema", () => {
  it("coerce limit 并校验范围", () => {
    expect(billingRecordsListQuerySchema.parse({ limit: "20" })).toEqual({ limit: 20 });
    expect(() => billingRecordsListQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => billingRecordsListQuerySchema.parse({ limit: "101" })).toThrow();
  });
});

describe("billingRecordsListResponseSchema", () => {
  it("接受标准成功响应", () => {
    const payload = {
      records: [recurringRecord()],
      nextCursor: null,
      total: 1,
    };
    const response = { ok: true as const, data: payload };
    expect(billingRecordsListResponseSchema.parse(response)).toBeTruthy();
  });
});
