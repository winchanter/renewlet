// 订阅详情测试保护列表/仪表盘/日历共用的只读详情入口，避免备注和网站再次只能在编辑表单中阅读。
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { assertDateOnly } from "@/lib/time/date-only";
import { subscriptionCycleFixture } from "@/test/subscription-fixtures";
import type { Subscription, SubscriptionCollectionItem } from "@/types/subscription";
import { SubscriptionDetailDialog } from "./subscription-detail-dialog";

const mocks = vi.hoisted(() => ({
  categories: [
    {
      id: "developer-tools",
      value: "developer-tools",
      labels: { "zh-CN": "开发工具", "en-US": "Developer tools" },
      color: "hsl(200 80% 50%)",
    },
  ],
  paymentMethods: [
    {
      id: "credit-card",
      value: "credit_card",
      labels: { "zh-CN": "信用卡", "en-US": "Credit card" },
      icon: "/icons/payment-methods/credit_card.svg",
    },
  ],
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      categories: mocks.categories,
      statuses: [],
      paymentMethods: mocks.paymentMethods,
      currencies: [],
    },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { notificationReminderDays: 5 },
  }),
}));

vi.mock("@/hooks/use-calendar-feed", () => ({
  useCalendarFeedStatus: () => ({
    data: { enabled: false, feedUrl: undefined },
    isError: false,
    isFetching: false,
    isPending: false,
    refetch: vi.fn(),
  }),
  useCreateCalendarFeed: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useDeleteCalendarFeed: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useRotateCalendarFeed: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

const baseSubscription: Subscription = {
  id: "sub-1",
  name: "Fastmail",
  logo: undefined,
  price: "159",
  currency: "USD",
  billingCycle: "monthly",
  customDays: undefined,
  customCycleUnit: undefined,
  category: "developer-tools",
  status: "active",
  paymentMethod: "credit_card",
  startDate: assertDateOnly("2026-05-15"),
  nextBillingDate: assertDateOnly("2026-06-15"),
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  trialEndDate: undefined,
  website: "https://fastmail.example/billing",
  notes: "团队年度订阅\n负责人：Alice\nhttps://very-long-example.test/path/to/invoice",
  tags: ["team", "mail"],
  reminderDays: -1,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
  pinned: false,
  publicHidden: false,
};

function testCurrencyConvert(amount: number | string, fromCurrency: string, toCurrency: string): number {
  const value = typeof amount === "number" ? amount : Number(amount);
  if (fromCurrency === toCurrency) return value;
  if (fromCurrency === "USD" && toCurrency === "CNY") return value * 7;
  if (fromCurrency === "CNY" && toCurrency === "USD") return value / 7;
  return value;
}

function renderDetailDialog({
  subscription = baseSubscription,
  open = true,
  onOpenChange = vi.fn(),
  onEditSubscription,
  onRenewSubscription,
  onViewBillingRecords,
  priceReferenceCurrency = "CNY",
  loading = false,
  loadingPreview = subscription,
}: {
  subscription?: Subscription | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEditSubscription?: (subscription: Subscription) => void;
  onRenewSubscription?: (id: string) => void;
  onViewBillingRecords?: (id: string) => void;
  priceReferenceCurrency?: string | null;
  loading?: boolean;
  loadingPreview?: SubscriptionCollectionItem | null;
} = {}) {
  return {
    onOpenChange,
    ...render(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDetailDialog
          open={open}
          onOpenChange={onOpenChange}
          subscription={subscription}
          loadingPreview={loadingPreview}
          today={assertDateOnly("2026-05-18")}
          currencyConvert={testCurrencyConvert}
          currencyRatesReady={true}
          priceReferenceCurrency={priceReferenceCurrency}
          loading={loading}
          {...(onEditSubscription ? { onEditSubscription } : {})}
          {...(onRenewSubscription ? { onRenewSubscription } : {})}
          {...(onViewBillingRecords ? { onViewBillingRecords } : {})}
        />
      </TooltipProvider>,
    ),
  };
}

function mockMobile(matches = true) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 639px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("SubscriptionDetailDialog", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("uses the detail scaffold while the complete detail model is pending", () => {
    const onOpenChange = vi.fn();
    const preview = baseSubscription;
    const { rerender } = renderDetailDialog({
      subscription: null,
      loadingPreview: preview,
      loading: true,
      onOpenChange,
      onEditSubscription: vi.fn(),
    });
    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    const identityRegion = dialog.querySelector('[data-dialog-region="subscription-identity"]');
    expect(screen.getByTestId("subscription-detail-data-loading")).toBeInTheDocument();

    rerender(
      <TooltipProvider delayDuration={0}>
        <SubscriptionDetailDialog
          open
          onOpenChange={onOpenChange}
          subscription={baseSubscription}
          loadingPreview={preview}
          today={assertDateOnly("2026-05-18")}
          currencyConvert={testCurrencyConvert}
          currencyRatesReady
          priceReferenceCurrency="CNY"
          onEditSubscription={vi.fn()}
          loading={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("dialog", { name: "Fastmail" })).toBe(dialog);
    expect(dialog.querySelector('[data-dialog-region="subscription-identity"]')).toBe(identityRegion);
    expect(screen.queryByTestId("subscription-detail-data-loading")).not.toBeInTheDocument();
    expect(screen.getByText("团队年度订阅", { exact: false })).toBeInTheDocument();
  });

  it("renders website, notes, payment method, tags, and inherited reminder in the read-only detail view", () => {
    renderDetailDialog();

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    expect(dialog).toHaveAccessibleDescription("查看 Fastmail 的价格、周期、日期、标签、网站和备注。");
    expect(within(dialog).getByText("$159 USD")).toBeInTheDocument();
    expect(within(dialog).getByText("日均支出")).toBeInTheDocument();
    expect(within(dialog).getByText("$5.3")).toHaveClass("tabular-nums");
    expect(within(dialog).getByText("≈ ¥1,113 CNY")).toHaveClass(
      "text-xs",
      "tabular-nums",
      "text-muted-foreground",
    );
    expect(within(dialog).getAllByText("开发工具")).toHaveLength(2);
    expect(within(dialog).getByText("信用卡")).toBeInTheDocument();
    expect(within(dialog).getByText("默认提醒：提前 5 天")).toBeInTheDocument();
    expect(within(dialog).getByText("team")).toBeInTheDocument();
    expect(within(dialog).getByText("mail")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /https:\/\/fastmail\.example\/billing/ })).toHaveAttribute(
      "href",
      "https://fastmail.example/billing",
    );
    expect(within(dialog).getByText(/团队年度订阅/)).toHaveClass("whitespace-pre-wrap", "wrap-break-word");
    expect(within(dialog).getByText(/负责人：Alice/)).toBeInTheDocument();
  });

  it("shows the relative renewal countdown under the status badge in the summary block", () => {
    renderDetailDialog();

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    const relative = within(dialog).getByTestId("subscription-detail-relative-billing");

    expect(within(dialog).getByText("28 天后续费")).toBe(relative);
    expect(relative).toHaveClass("text-sm", "tabular-nums", "text-muted-foreground");
  });

  it("tones the relative renewal countdown as warning within seven days and destructive when expired", () => {
    const upcoming = renderDetailDialog({
      subscription: { ...baseSubscription, nextBillingDate: assertDateOnly("2026-05-20") },
    });
    expect(within(screen.getByRole("dialog", { name: "Fastmail" })).getByTestId("subscription-detail-relative-billing"))
      .toHaveTextContent("2 天后续费");
    expect(screen.getByTestId("subscription-detail-relative-billing")).toHaveClass("text-warning");
    upcoming.unmount();

    renderDetailDialog({
      subscription: { ...baseSubscription, nextBillingDate: assertDateOnly("2026-05-15") },
    });
    const expired = screen.getByTestId("subscription-detail-relative-billing");
    expect(expired).toHaveTextContent("已过期 3 天");
    expect(expired).toHaveClass("text-destructive");
  });

  it("keeps the relative renewal countdown out of buyout details", () => {
    renderDetailDialog({
      subscription: { ...baseSubscription, ...subscriptionCycleFixture({ billingCycle: "one-time" }) },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });

    expect(within(dialog).queryByTestId("subscription-detail-relative-billing")).not.toBeInTheDocument();
  });

  it("hides the start-date row when a recurring subscription has an unknown start date", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        startDate: null,
        autoCalculateNextBillingDate: false,
      },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });

    expect(within(dialog).queryByText("开始日期")).not.toBeInTheDocument();
    expect(within(dialog).getByText("2026年6月15日")).toBeInTheDocument();
  });

  it("hides the reference for same-currency subscriptions and disabled settings", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        price: "159",
        currency: "CNY",
      },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });

    expect(within(dialog).getByText("¥159 CNY")).toBeInTheDocument();
    expect(within(dialog).queryByText(/^≈/)).not.toBeInTheDocument();

    renderDetailDialog({ priceReferenceCurrency: null });
    const dialogs = screen.getAllByRole("dialog");
    const latestDialog = dialogs[dialogs.length - 1];
    if (!latestDialog) throw new Error("Missing latest detail dialog");
    expect(latestDialog).not.toHaveTextContent("≈ ¥1,113 CNY");
  });

  it("keeps the reference out of cost-sharing detail rows", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        costSharing: {
          enabled: true,
          splitMode: "custom",
          members: [
            { id: "member-1", name: "Bob", currency: "USD", customAmount: "40" },
          ],
        },
      },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });

    expect(within(dialog).getAllByText(/^≈/)).toHaveLength(1);
    expect(within(dialog).getByText("成员合计")).toBeInTheDocument();
    expect(within(dialog).getByText("你的份额")).toBeInTheDocument();
    expect(within(dialog).getByText("$5.3")).toBeInTheDocument();
  });

  it("hides buyout daily cost and amortizes one-time fixed terms", () => {
    const buyout = renderDetailDialog({
      subscription: { ...baseSubscription, ...subscriptionCycleFixture({ billingCycle: "one-time" }) },
    });
    expect(within(screen.getByRole("dialog", { name: "Fastmail" })).queryByText("日均支出")).not.toBeInTheDocument();
    buyout.unmount();

    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        price: "180",
        ...subscriptionCycleFixture({ billingCycle: "one-time", oneTimeTermCount: 6, oneTimeTermUnit: "month" }),
      },
    });
    const fixedTermDialog = screen.getByRole("dialog", { name: "Fastmail" });
    expect(within(fixedTermDialog).getByText("日均支出")).toBeInTheDocument();
    expect(within(fixedTermDialog).getByText("$1")).toBeInTheDocument();
  });

  it("closes the detail dialog before opening the edit flow", () => {
    const onOpenChange = vi.fn();
    const onEditSubscription = vi.fn();
    renderDetailDialog({ onOpenChange, onEditSubscription });

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onEditSubscription).toHaveBeenCalledWith(baseSubscription);
  });

  it("uses a compact desktop footer for detail actions", () => {
    const onEditSubscription = vi.fn();
    const onRenewSubscription = vi.fn();
    const onViewBillingRecords = vi.fn();
    renderDetailDialog({ onEditSubscription, onRenewSubscription, onViewBillingRecords });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    const editButton = within(dialog).getByRole("button", { name: "编辑" });
    const actions = editButton.parentElement;
    if (!actions) throw new Error("Missing subscription detail action footer");

    expect(actions).toHaveClass("flex", "flex-col", "border-t", "sm:flex-row", "sm:justify-end");
    expect(actions).not.toHaveClass("sm:grid-cols-2");
    expect(within(actions).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "历史记录",
      "添加到日历",
      "续订",
      "编辑",
    ]);
  });

  it("renders concrete custom billing cycle labels", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        ...subscriptionCycleFixture({
          billingCycle: "custom",
          customDays: 2,
          customCycleUnit: "week",
        }),
      },
    });

    const dialog = screen.getByRole("dialog", { name: "Fastmail" });
    expect(within(dialog).getByText("每 2 周")).toBeInTheDocument();
    expect(within(dialog).queryByText("自定义")).not.toBeInTheDocument();
  });

  it("renders disabled reminders in the read-only detail view", () => {
    renderDetailDialog({
      subscription: {
        ...baseSubscription,
        reminderDays: -2,
      },
    });

    expect(within(screen.getByRole("dialog", { name: "Fastmail" })).getByText("不提醒")).toBeInTheDocument();
  });

  it("uses a mobile drawer for small screens", () => {
    mockMobile(true);
    renderDetailDialog();

    const drawer = screen.getByRole("dialog", { name: "Fastmail" });

    expect(drawer).toHaveClass("h5-drawer-panel", "overflow-hidden");
    expect(within(drawer).getAllByRole("button", { name: "关闭" })).toHaveLength(1);
    expect(within(drawer).getByText(/团队年度订阅/)).toBeInTheDocument();
  });
});
