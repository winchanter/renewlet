// 订阅 service 测试保护产品 API DTO 进入前端 domain 前的运行时校验边界。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  subscriptionCreateBodySchema,
  subscriptionUpdateBodySchema,
  type ApiSubscription,
  type ApiSubscriptionCollectionItem,
} from "@/lib/api/schemas/subscriptions";
import { assertDateOnly } from "@/lib/time/date-only";
import type { BillingCycle, SubscriptionFormSubmission } from "@/types/subscription";
import {
  fromApiSubscription,
  subscriptionService,
  toSubscriptionCreatePayload,
  toSubscriptionUpdatePayload,
} from "./subscription-service";

type ApiFetchMock = (url: string, schema: unknown, init?: RequestInit) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<ApiFetchMock>(),
  getCurrentUserId: vi.fn(() => "user_1"),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@/lib/pocketbase", () => ({
  pb: {
    lang: "zh-CN",
    beforeSend: undefined,
  },
  getCurrentUserId: mocks.getCurrentUserId,
}));

const legacyPocketBaseRow = {
  collectionId: "subscriptions",
  collectionName: "subscriptions",
  id: "sub_legacy",
  name: "Perplexity Pro",
  logo: "https://example.com/perplexity.svg",
  price: "20",
  currency: "USD",
  billingCycle: "monthly",
  customDays: 0,
  customCycleUnit: "",
  category: "ai_tools",
  status: "active",
  pinned: false,
  publicHidden: false,
  paymentMethod: "apple_pay",
  startDate: "2026-02-03",
  nextBillingDate: "2026-05-29",
  autoCalculateNextBillingDate: false,
  trialEndDate: "",
  website: "https://www.perplexity.ai/",
  notes: "Demo data",
  tags: ["AI", "Search"],
  reminderDays: 7,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  created: "2026-06-04 23:43:33.958Z",
  updated: "2026-06-04 23:43:33.958Z",
};

const apiSubscription = {
  id: "sub_api",
  name: "API Subscription",
  price: "12",
  currency: "USD",
  billingCycle: "monthly",
  category: "productivity",
  status: "active",
  pinned: false,
  publicHidden: false,
  startDate: "2026-01-01",
  nextBillingDate: "2026-02-01",
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  tags: ["api"],
  reminderDays: 3,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
} satisfies ApiSubscription;

const apiCollectionItem = {
  id: apiSubscription.id,
  name: apiSubscription.name,
  price: apiSubscription.price,
  currency: apiSubscription.currency,
  billingCycle: apiSubscription.billingCycle,
  category: apiSubscription.category,
  status: apiSubscription.status,
  pinned: apiSubscription.pinned,
  publicHidden: apiSubscription.publicHidden,
  startDate: apiSubscription.startDate,
  nextBillingDate: apiSubscription.nextBillingDate,
  autoRenew: apiSubscription.autoRenew,
  autoCalculateNextBillingDate: apiSubscription.autoCalculateNextBillingDate,
  reminderDays: apiSubscription.reminderDays,
} satisfies ApiSubscriptionCollectionItem;

type RecurringFormSubmission = Extract<
  SubscriptionFormSubmission,
  { billingCycle: Exclude<BillingCycle, "custom" | "one-time"> }
>;

function formSubmission(overrides: Partial<RecurringFormSubmission> = {}): RecurringFormSubmission {
  return {
    name: apiSubscription.name,
    logo: undefined,
    price: apiSubscription.price,
    currency: apiSubscription.currency,
    billingCycle: "monthly",
    category: apiSubscription.category,
    status: apiSubscription.status,
    publicHidden: apiSubscription.publicHidden,
    paymentMethod: undefined,
    startDate: assertDateOnly(apiSubscription.startDate),
    nextBillingDate: assertDateOnly(apiSubscription.nextBillingDate),
    autoRenew: apiSubscription.autoRenew,
    autoCalculateNextBillingDate: apiSubscription.autoCalculateNextBillingDate,
    website: undefined,
    notes: undefined,
    tags: apiSubscription.tags,
    reminderDays: apiSubscription.reminderDays,
    repeatReminderEnabled: apiSubscription.repeatReminderEnabled,
    repeatReminderInterval: apiSubscription.repeatReminderInterval,
    repeatReminderWindow: apiSubscription.repeatReminderWindow,
    costSharing: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.getCurrentUserId.mockReturnValue("user_1");
});

describe("subscription service normalization", () => {
  it("rejects legacy PocketBase records at the product API boundary", () => {
    expect(() => fromApiSubscription(legacyPocketBaseRow)).toThrow();
  });

  it("rejects custom fields on fixed product API cycles", () => {
    expect(() => fromApiSubscription({
      ...apiSubscription,
      customDays: 45,
      customCycleUnit: "year",
    })).toThrow();
  });

  it("rejects incomplete custom product API rows", () => {
    expect(() => fromApiSubscription({
      ...apiSubscription,
      billingCycle: "custom",
      customDays: 45,
    })).toThrow();
  });

  it("keeps supported custom cycle units", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    });

    expect(subscription).toMatchObject({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    });
  });

  it("passes the current-user-payer cost sharing shape through the service boundary", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      price: "100",
      costSharing: {
        enabled: true,
        splitMode: "custom",
        members: [
          { id: "partner", name: "Partner", customAmount: "40" },
          { id: "child", name: "Child", customAmount: "60" },
        ],
      },
    });
    const payload = toSubscriptionUpdatePayload(formSubmission({
      price: "100",
      costSharing: subscription.costSharing,
    }));

    expect(payload.costSharing).toEqual(subscription.costSharing);
    expect(toSubscriptionUpdatePayload(formSubmission()).costSharing).toBeNull();
  });

  it("parses and writes nullable start dates for manual recurring subscriptions", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      startDate: null,
      autoCalculateNextBillingDate: false,
    });
    const payload = toSubscriptionUpdatePayload(formSubmission({
      startDate: null,
      autoCalculateNextBillingDate: false,
    }));

    expect(subscription.startDate).toBeNull();
    expect(payload.startDate).toBeNull();
    expect(payload.autoCalculateNextBillingDate).toBe(false);
  });
});

describe("subscription service API calls", () => {
  it("lists subscriptions through the Renewo product API", async () => {
    mocks.apiFetch.mockResolvedValue({
      subscriptions: [apiCollectionItem],
      nextCursor: "next",
      total: 1,
    });

    const page = await subscriptionService.listPage("cursor", 25);

    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/app/subscriptions?limit=25&cursor=cursor", expect.anything(), undefined);
    expect(page.subscriptions).toHaveLength(1);
    expect(page.nextCursor).toBe("next");
  });

  it("serializes custom list filters as repeated product API query params", async () => {
    mocks.apiFetch.mockResolvedValue({
      subscriptions: [],
      nextCursor: null,
      total: 0,
    });

    await subscriptionService.listPage(null, 25, {
      q: "cursor",
      category: ["developer_tools", "ai"],
      tag: ["Team"],
      billingCycle: ["monthly"],
      paymentMethod: ["paypal", "__none"],
      currency: ["USD"],
      status: "active",
      renewal: "auto",
      nextBillingFrom: "2999-08-01",
      nextBillingTo: "2999-08-31",
      pinned: true,
      publicHidden: false,
      reminderMode: "custom",
      repeatReminder: true,
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/api/app/subscriptions?limit=25&q=cursor&category=developer_tools&category=ai&tag=Team&billingCycle=monthly&paymentMethod=paypal&paymentMethod=__none&currency=USD&status=active&renewal=auto&nextBillingFrom=2999-08-01&nextBillingTo=2999-08-31&pinned=true&publicHidden=false&reminderMode=custom&repeatReminder=true",
      expect.anything(),
      undefined,
    );
  });

  it("loads the filtered index once and forwards the caller AbortSignal", async () => {
    const controller = new AbortController();
    mocks.apiFetch.mockResolvedValue({ subscriptions: [apiCollectionItem], total: 1 });

    const index = await subscriptionService.index({ q: "api", category: ["productivity"] }, controller.signal);

    expect(index.subscriptions).toHaveLength(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/api/app/subscriptions/index?q=api&category=productivity",
      expect.anything(),
      { signal: controller.signal },
    );
  });

  it("creates and updates subscriptions through /api/app/subscriptions", async () => {
    mocks.apiFetch.mockResolvedValue({ subscription: apiSubscription });
    const subscription = fromApiSubscription(apiSubscription);
    const changes = formSubmission();

    await subscriptionService.create({ ...changes, pinned: subscription.pinned, extra: subscription.extra });
    await subscriptionService.update(subscription.id, changes);

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({ method: "POST" });
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/subscriptions/sub_api");
    expect(mocks.apiFetch.mock.calls[1]?.[2]).toMatchObject({ method: "PATCH" });
    expect(toSubscriptionCreatePayload({ ...changes, pinned: false })).not.toHaveProperty("extra");
    const updateBody: unknown = JSON.parse(String(mocks.apiFetch.mock.calls[1]?.[2]?.body));
    const updatePayload = subscriptionUpdateBodySchema.parse(updateBody);
    expect(updatePayload).not.toHaveProperty("pinned");
    expect(updatePayload).not.toHaveProperty("extra");
    // 非试用态默认草稿显式清空试用到期日，保持状态与字段一致。
    expect(updatePayload.trialEndDate).toBeNull();
  });

  it("sends form-owned trial end date in create and update payloads", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      status: "trial",
      trialEndDate: "2026-01-20",
    });
    // 试用态携带试用到期日：提交后应原样写入 create/update 载荷。
    const trialChanges = formSubmission({ status: "trial", trialEndDate: "2026-01-20" });
    const trialCreatePayload = subscriptionCreateBodySchema.parse(
      toSubscriptionCreatePayload({ ...trialChanges, pinned: false }),
    );
    const trialUpdatePayload = subscriptionUpdateBodySchema.parse(toSubscriptionUpdatePayload(trialChanges));

    expect(subscription.trialEndDate).toBe("2026-01-20");
    expect(trialCreatePayload.trialEndDate).toBe("2026-01-20");
    expect(trialUpdatePayload.trialEndDate).toBe("2026-01-20");

    // 试用态但未填试用到期日：载荷以 null 显式清空，避免后端保留陈旧试用日期。
    const blankTrialChanges = formSubmission({ status: "trial" });
    const blankUpdatePayload = subscriptionUpdateBodySchema.parse(toSubscriptionUpdatePayload(blankTrialChanges));
    expect(blankUpdatePayload.trialEndDate).toBeNull();
  });

  it("patches quick-action fields without sending a full subscription snapshot", async () => {
    mocks.apiFetch.mockResolvedValue({ subscription: { ...apiSubscription, pinned: true } });

    await subscriptionService.patch("sub_api", { pinned: true });

    const init = mocks.apiFetch.mock.calls[0]?.[2];
    const body: unknown = JSON.parse(String(init?.body));
    const payload = subscriptionUpdateBodySchema.parse(body);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/sub_api");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(payload).toEqual({ pinned: true });
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("nextBillingDate");
  });

  it("renews with an explicit payload and deletes through the product API", async () => {
    mocks.apiFetch.mockResolvedValueOnce({ subscription: apiSubscription }).mockResolvedValueOnce({});
    const renewPayload = {
      mode: "continue",
      price: "15",
      currency: "USD",
      startDate: null,
      nextBillingDate: "2026-03-01",
      autoCalculateNextBillingDate: false,
    } as const;

    await subscriptionService.renew("sub_api", renewPayload);
    await subscriptionService.delete("sub_api");

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/sub_api/renew");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({ method: "POST", body: JSON.stringify(renewPayload) });
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/subscriptions/sub_api");
    expect(mocks.apiFetch.mock.calls[1]?.[2]).toMatchObject({ method: "DELETE" });
  });
});
