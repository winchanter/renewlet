import { describe, expect, it } from "vitest";
import { subscriptionCollectionQueryPlan } from "./subscription-list-filters";

const USER_ID = "usr_subscription_owner";

describe("subscription collection query plan", () => {
  it("keeps all filters owner-scoped and reads only collection fact columns", () => {
    const plan = subscriptionCollectionQueryPlan(USER_ID, {
      q: "Cursor",
      category: ["developer_tools"],
      tag: ["AI"],
      billingCycle: ["monthly"],
      paymentMethod: ["paypal"],
      currency: ["USD"],
      status: "active",
      renewal: "auto",
      nextBillingFrom: "2999-08-01",
      nextBillingTo: "2999-08-31",
      pinned: true,
      publicHidden: false,
      reminderMode: "custom",
      repeatReminder: true,
    }, "2999-07-30", 11);

    for (const query of [plan.count, plan.facts]) {
      expect(query.sql).toContain("idx.user_id = ?");
      expect(query.sql).toContain("idx.category IN (?)");
      expect(query.sql).toContain("idx.billing_cycle IN (?)");
      expect(query.sql).toContain("idx.currency IN (?)");
      expect(query.sql).toContain("idx.payment_method IN (?)");
      expect(query.sql).toContain("idx.next_billing_date >= ?");
      expect(query.sql).toContain("idx.pinned = ?");
      expect(query.sql).toContain("idx.reminder_days >= 0");
      expect(query.sql).toContain("instr(idx.search_text_lower, ?) > 0");
    }
    expect(plan.count.sql).not.toContain("JOIN subscriptions");
    expect(plan.facts.sql).toContain("INNER JOIN subscriptions AS sub");
    expect(plan.facts.sql).toContain("sub.auto_calculate_next_billing_date");
    expect(plan.facts.sql).not.toContain("sub.notes");
    // tags 是列表视图的事实列：标签筛选和展示都需要，不再属于被排除的大字段。
    expect(plan.facts.sql).toContain("sub.tags_json");
    expect(plan.facts.sql).not.toContain("sub.extra_json");
    expect(plan.count.params).toEqual([
      USER_ID,
      "developer_tools",
      "monthly",
      "USD",
      "paypal",
      "ai",
      "AI",
      "2999-08-01",
      "2999-08-31",
      1,
      0,
      1,
      "cursor",
      "2999-07-30",
      "active",
    ]);
    expect(plan.facts.params).toEqual([...plan.count.params, 11]);
  });

  it("keeps cursor parameters out of the exact count query", () => {
    const plan = subscriptionCollectionQueryPlan(USER_ID, {}, "", 51, {
      createdAt: "2026-08-18T10:00:00.000Z",
      id: "sub_cursor",
    });

    expect(plan.count.params).toEqual([USER_ID]);
    expect(plan.facts.params).toEqual([
      USER_ID,
      "2026-08-18T10:00:00.000Z",
      "2026-08-18T10:00:00.000Z",
      "sub_cursor",
      51,
    ]);
  });
});
