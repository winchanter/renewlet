import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import type { Subscription } from "@/types/subscription";
import {
  RenewSubscriptionDialogContent,
  type RenewSubscriptionDialogProps,
} from "./renew-subscription-dialog";

function RenewSubscriptionDialog(props: RenewSubscriptionDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        closeLabel="关闭"
        dismissMode="explicit"
        layout="content"
        className="h5-dialog-auto-frame gap-0 border-border bg-card p-0 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          if (!props.restoreFocusRef?.current) return;
          event.preventDefault();
          props.restoreFocusRef.current.focus();
        }}
      >
        <RenewSubscriptionDialogContent {...props} />
      </DialogContent>
    </Dialog>
  );
}

// jsdom 的 DragEvent 默认 dataTransfer 为 null，需手动注入才能在 onDrop 里读到 files。
function dropFiles(element: Element, files: File[]) {
  const dropEvent = createEvent.drop(element);
  Object.defineProperty(dropEvent, "dataTransfer", {
    value: {
      files,
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      types: ["Files"],
    },
    configurable: true,
  });
  fireEvent(element, dropEvent);
}

const mocks = vi.hoisted(() => ({
  config: {
    currencies: [
      { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
      { id: "EUR", value: "EUR", labels: { "zh-CN": "€ 欧元 (EUR)", "en-US": "€ Euro (EUR)" }, enabled: true },
    ],
  },
  uploadImageFile: vi.fn(),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({ config: mocks.config }),
}));

vi.mock("@/lib/upload-image", () => ({
  uploadImageFile: mocks.uploadImageFile,
}));

vi.mock("@/components/authorized-image", () => ({
  AuthorizedImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img src={src} alt={alt} data-testid="authorized-image" />
  ),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string, values?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        "common.cancel": "取消",
        "common.close": "关闭",
        "subscription.billingRecords.viewHistory": "查看历史记录",
        "subscription.billingRecords.receipt": "续订凭证",
        "subscription.billingRecords.receiptHint": `可选，最多 ${String(values?.["count"] ?? "")} 张；保存后随本期扣费记录一起留存。`,
        "subscription.billingRecords.receiptAdd": "添加凭证",
        "subscription.billingRecords.receiptRemove": `移除凭证 ${String(values?.["index"] ?? "")}`,
        "subscription.billingRecords.receiptView": `查看凭证 ${String(values?.["index"] ?? "")}`,
        "subscription.billingRecords.receiptEmpty": "暂无凭证",
        "subscription.billingRecords.receiptDropHint": "拖拽图片到此处，或点击下方按钮添加",
        "subscription.billingRecords.receiptsLabel": `凭证 ${String(values?.["count"] ?? "")}/${String(values?.["max"] ?? "")}`,
        "media.uploadFailed": "上传失败，请重试",
        "subscription.empty.currency": "未找到货币",
        "subscription.field.currency": "货币",
        "subscription.field.nextBillingDate": "到期日期",
        "subscription.field.price": "价格",
        "subscription.field.startDate": "开始日期",
        "subscription.field.usagePackage": "量包",
        "subscription.field.usageUnit": "单位",
        "subscription.field.usageTotal": "总量",
        "subscription.field.usageDailyRate": "日均消耗预估",
        "subscription.field.usageExhaustionDate": "预计耗尽日",
        "subscription.placeholder.usageUnit": "如：条、GB、次",
        "subscription.placeholder.usageTotal": "总量，如 1000",
        "subscription.placeholder.usageDailyRate": "日均，如 10",
        "subscription.usageEstimatedDays": `按当前日均约可用 ${String(values?.["days"] ?? "")} 天`,
        "subscription.usageExhaustionDateHelp": "由购买日和总量/日均自动推算。",
        "subscription.placeholder.currency": "选择货币",
        "subscription.placeholder.date": "选择日期",
        "subscription.renew": "续订",
        "subscription.renew.description": "选择续订方式，并确认本次续订后的价格、货币和扣费日期。",
        "subscription.renew.continueNextBillingDate": "续订后下次扣费日",
        "subscription.renew.currentNextBillingDate": "当前下次扣费日",
        "subscription.renew.mode": "续订方式",
        "subscription.renew.modeContinue": "延续下一期",
        "subscription.renew.modeContinueHelp": "适合订阅一直在用，只确认下一期继续。系统会按原周期自动推进下次扣费日。",
        "subscription.renew.modeContinueShort": "按原周期锚点推进日期。",
        "subscription.renew.modeRestart": "重新开始订阅",
        "subscription.renew.modeRestartHelp": "适合中间断订后重新订阅。可以设置新的开始日期和下次扣费日。",
        "subscription.renew.modeRestartShort": "把新日期写成开始日。",
        "subscription.renew.modeUsageBasedHelp": "购买新量包：填写新量包的总量、单位和日均消耗预估，耗尽日自动推算。",
        "subscription.renew.restartSubmit": "重新开始订阅",
        "subscription.renew.submit": "确认续订",
        "subscription.renew.title": `续订「${String(values?.["name"] ?? "")}」`,
        "subscription.renew.validation.startDateRequired": "请选择新的开始日期",
        "subscription.search.currency": "搜索货币、代码或符号...",
        "subscription.validation.amountInvalid": "金额必须是 0 到 1,000,000,000 之间的有效数字",
        "subscription.validation.dateOrderInvalid": "到期日期不能早于开始日期",
      };
      return messages[key] ?? key;
    },
    formatDateOnly: (value: string) => value,
    formatDateTime: (value: Date | string) => {
      const date = value instanceof Date ? value : new Date(value);
      return date.toISOString().slice(0, 10);
    },
  }),
}));

beforeEach(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
  mocks.uploadImageFile.mockReset();
  mocks.uploadImageFile.mockResolvedValue({ url: "/api/app/assets/receipt-1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setupUser() {
  return userEvent.setup();
}

function makeSubscription(overrides: SubscriptionFixtureOverrides<Subscription> = {}): Subscription {
  return {
    id: "sub-renew",
    name: "Renewable SaaS",
    logo: undefined,
    price: "12",
    currency: "USD",
    category: "productivity",
    status: "expired",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-31"),
    nextBillingDate: assertDateOnly("2026-02-28"),
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

function renderDialog(props: Partial<ComponentProps<typeof RenewSubscriptionDialog>> = {}) {
  const onSubmit = vi.fn<NonNullable<ComponentProps<typeof RenewSubscriptionDialog>["onSubmit"]>>();
  const onOpenChange = vi.fn();
  render(
    <TooltipProvider delayDuration={0}>
      <RenewSubscriptionDialog
        subscription={makeSubscription()}
        loadingPreview={null}
        open
        today={assertDateOnly("2026-08-12")}
        submitting={false}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onSubmit, onOpenChange };
}

function FocusRestoreHarness() {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <TooltipProvider delayDuration={0}>
      <button type="button" ref={triggerRef}>续订入口</button>
      <RenewSubscriptionDialog
        subscription={makeSubscription()}
        loadingPreview={null}
        open={open}
        today={assertDateOnly("2026-08-12")}
        submitting={false}
        restoreFocusRef={triggerRef}
        onOpenChange={setOpen}
        onSubmit={vi.fn()}
      />
    </TooltipProvider>
  );
}

describe("RenewSubscriptionDialog", () => {
  it("uses the resolved renewal scaffold while detail data is pending", () => {
    const preview = makeSubscription({ status: "expired" });
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <RenewSubscriptionDialog
          subscription={null}
          loadingPreview={preview}
          open
          today={assertDateOnly("2026-08-12")}
          submitting={false}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          loading
        />
      </TooltipProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "续订「Renewable SaaS」" });
    const form = dialog.querySelector("form");
    expect(screen.getByTestId("renew-subscription-data-loading")).toBeInTheDocument();

    rerender(
      <TooltipProvider delayDuration={0}>
        <RenewSubscriptionDialog
          subscription={preview}
          loadingPreview={preview}
          open
          today={assertDateOnly("2026-08-12")}
          submitting={false}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          loading={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("dialog", { name: "续订「Renewable SaaS」" })).toBe(dialog);
    expect(dialog.querySelector("form")).toBe(form);
    expect(screen.queryByTestId("renew-subscription-data-loading")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /重新开始订阅/ })).toBeChecked();
  });

  it("opens expired subscriptions in restart mode by default", async () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "续订「Renewable SaaS」" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveClass("h5-dialog-auto-frame", "h-fit", "gap-0");
    expect(dialog).not.toHaveClass("h5-dialog-frame");
    const form = dialog.querySelector("form");
    expect(form).toHaveClass("flex", "min-h-0", "flex-col", "overflow-hidden");
    expect(form).not.toHaveClass("h5-subscription-dialog-form");
    expect(screen.getByRole("radio", { name: /重新开始订阅/ })).toBeChecked();
    expect(screen.getByRole("button", { name: /开始日期 2026-08-12/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /到期日期 2026-09-12/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重新开始订阅" })).toBeEnabled();
    const pricingRow = screen.getByLabelText("价格").closest('[data-slot="form-field-row"]');
    const scheduleRow = screen.getByRole("button", { name: /开始日期 2026-08-12/ }).closest('[data-slot="form-field-row"]');
    expect(pricingRow).toHaveAttribute("data-align-at", "sm");
    expect(pricingRow).toHaveAttribute("data-tracks", "2");
    expect(scheduleRow).toHaveAttribute("data-align-at", "sm");
    expect(scheduleRow).toHaveAttribute("data-tracks", "2");
  });

  it("opens active subscriptions in continue mode and submits an explicit payload", async () => {
    const user = setupUser();
    const { onSubmit } = renderDialog({ subscription: makeSubscription({ status: "active" }) });

    expect(screen.getByRole("dialog", { name: "续订「Renewable SaaS」" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /延续下一期/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: /开始日期/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /到期日期/ })).not.toBeInTheDocument();
    expect(screen.getByText("当前下次扣费日")).toBeInTheDocument();
    expect(screen.getByText("续订后下次扣费日")).toBeInTheDocument();
    expect(screen.getByText("2026-02-28")).toBeInTheDocument();
    expect(screen.getByText("2026-08-31")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("价格"));
    await user.type(screen.getByLabelText("价格"), "15.50");
    await user.click(screen.getByRole("combobox", { name: "货币" }));
    await user.click(within(screen.getByRole("listbox")).getByText("€ 欧元 (EUR)"));
    await user.click(screen.getByRole("button", { name: "确认续订" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      mode: "continue",
      price: "15.5",
      currency: "EUR",
      startDate: null,
      nextBillingDate: "2026-08-31",
      autoCalculateNextBillingDate: false,
    }));
  });

  it("renders usage-based renew as usage pack form with auto-computed exhaustion date", async () => {
    const user = setupUser();
    renderDialog({
      subscription: makeSubscription({
        status: "active",
        billingCycle: "usage-based",
        usageUnit: "条",
        usageTotal: 100,
        usageDailyRate: 10,
        nextBillingDate: assertDateOnly("2026-02-10"),
      }),
    });

    // 量包表单应可见，不显示 continue/restart RadioGroup。
    expect(screen.getByTestId("renew-usage-package-section")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /继续订阅|重新开始订阅/ })).toBeNull();

    // 总量预填为空（新量包），单位预填原订阅的"条"，日均预填 10。
    const totalInput = screen.getByLabelText("总量");
    expect(totalInput).toHaveValue("");
    const unitInput = screen.getByLabelText("单位");
    expect(unitInput).toHaveValue("条");
    const dailyRateInput = screen.getByLabelText("日均消耗预估");
    expect(dailyRateInput).toHaveValue("10");

    // 购买日默认今天，耗尽日 = 今天 + ceil(0/10) 天，因总量为空暂无推算。
    // 填入总量 200，耗尽日 = 今天 + ceil(200/10) = 今天 + 20 天。
    await user.type(totalInput, "200");
    // 耗尽日只读且自动推算：2026-08-12 + 20 天 = 2026-09-01。
    const exhaustionButton = screen.getByRole("button", { name: /预计耗尽日/, hidden: true });
    expect(exhaustionButton).toBeDisabled();
    expect(exhaustionButton).toHaveTextContent("2026-09-01");
  });

  it("switches to restart mode, recalculates default dates, and marks manual next date edits", async () => {
    const user = setupUser();
    const { onSubmit } = renderDialog({ subscription: makeSubscription({ status: "active" }) });

    await user.click(screen.getByRole("radio", { name: /重新开始订阅/ }));

    expect(screen.getByRole("button", { name: /开始日期 2026-08-12/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /到期日期 2026-09-12/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /到期日期 2026-09-12/ }));
    await user.click(within(screen.getByRole("gridcell", { name: "15" })).getByRole("button"));
    await user.click(screen.getByRole("button", { name: "重新开始订阅" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      mode: "restart",
      startDate: "2026-08-12",
      nextBillingDate: "2026-09-15",
      autoCalculateNextBillingDate: false,
    })));
  });

  it("focuses the first invalid field and disables duplicate submit while submitting", async () => {
    const user = setupUser();
    const { rerender } = render(
      <TooltipProvider delayDuration={0}>
        <RenewSubscriptionDialog
          subscription={makeSubscription()}
          loadingPreview={null}
          open
          today={assertDateOnly("2026-08-12")}
          submitting
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: /重新开始订阅/ })).toBeDisabled();

    rerender(
      <TooltipProvider delayDuration={0}>
        <RenewSubscriptionDialog
          subscription={makeSubscription()}
          loadingPreview={null}
          open
          today={assertDateOnly("2026-08-12")}
          submitting={false}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>,
    );
    await user.clear(screen.getByLabelText("价格"));
    await user.click(screen.getByRole("button", { name: "重新开始订阅" }));

    const invalidPrice = screen.getByLabelText("价格");
    await waitFor(() => expect(invalidPrice).toHaveFocus());
    expect(screen.getByText("金额必须是 0 到 1,000,000,000 之间的有效数字")).toBeInTheDocument();
  });

  it("restores focus to the renew entry after closing", async () => {
    const user = setupUser();
    render(<FocusRestoreHarness />);

    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "续订入口" })).toHaveFocus());
  });

  it("offers a billing records entry that hands the subscription id to the page", async () => {
    const user = setupUser();
    const onViewBillingRecords = vi.fn();
    renderDialog({ onViewBillingRecords });

    await user.click(screen.getByTestId("renew-view-billing-records"));

    expect(onViewBillingRecords).toHaveBeenCalledTimes(1);
    expect(onViewBillingRecords).toHaveBeenCalledWith("sub-renew");
  });

  it("hides the billing records entry when the page does not provide a handler", () => {
    renderDialog();

    expect(screen.queryByTestId("renew-view-billing-records")).not.toBeInTheDocument();
  });

  it("uploads renewal receipts and includes their asset ids in the submit payload", async () => {
    const user = setupUser();
    mocks.uploadImageFile
      .mockResolvedValueOnce({ url: "/api/app/assets/receipt-1" })
      .mockResolvedValueOnce({ url: "/api/app/assets/receipt-2" });

    const { onSubmit } = renderDialog({ subscription: makeSubscription({ status: "active" }) });

    const fileInput = screen.getByTestId("renew-receipt-input");
    await user.upload(fileInput, [
      new File(["a"], "receipt-1.png", { type: "image/png" }),
      new File(["b"], "receipt-2.png", { type: "image/png" }),
    ]);

    await waitFor(() => expect(mocks.uploadImageFile).toHaveBeenCalledTimes(2));
    // 两张缩略图都渲染出来。
    expect(screen.getAllByTestId("authorized-image")).toHaveLength(2);
    expect(screen.getByText("凭证 2/6")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认续订" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      receiptAssetIds: ["receipt-1", "receipt-2"],
    })));
  });

  it("omits receiptAssetIds from the payload when no receipt is uploaded", async () => {
    const user = setupUser();
    const { onSubmit } = renderDialog({ subscription: makeSubscription({ status: "active" }) });

    await user.click(screen.getByRole("button", { name: "确认续订" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("receiptAssetIds");
  });

  it("removes a receipt thumbnail and excludes its id from the payload", async () => {
    const user = setupUser();
    mocks.uploadImageFile
      .mockResolvedValueOnce({ url: "/api/app/assets/receipt-1" })
      .mockResolvedValueOnce({ url: "/api/app/assets/receipt-2" });

    const { onSubmit } = renderDialog({ subscription: makeSubscription({ status: "active" }) });

    const fileInput = screen.getByTestId("renew-receipt-input");
    await user.upload(fileInput, [
      new File(["a"], "receipt-1.png", { type: "image/png" }),
      new File(["b"], "receipt-2.png", { type: "image/png" }),
    ]);

    await waitFor(() => expect(screen.getAllByTestId("authorized-image")).toHaveLength(2));

    await user.click(screen.getByTestId("renew-receipt-remove-0"));

    expect(screen.getAllByTestId("authorized-image")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "确认续订" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      receiptAssetIds: ["receipt-2"],
    })));
  });

  it("accepts dragged images and uploads them", async () => {
    mocks.uploadImageFile
      .mockResolvedValueOnce({ url: "/api/app/assets/receipt-1" })
      .mockResolvedValueOnce({ url: "/api/app/assets/receipt-2" });

    renderDialog({ subscription: makeSubscription({ status: "active" }) });

    const dropzone = screen.getByTestId("renew-receipt-uploader");
    dropFiles(dropzone, [
      new File(["a"], "receipt-1.png", { type: "image/png" }),
      new File(["b"], "receipt-2.png", { type: "image/png" }),
    ]);

    await waitFor(() => expect(mocks.uploadImageFile).toHaveBeenCalledTimes(2));
    expect(screen.getAllByTestId("authorized-image")).toHaveLength(2);
    expect(screen.getByText("凭证 2/6")).toBeInTheDocument();
  });

  it("filters out non-image files dropped onto the uploader", async () => {
    renderDialog({ subscription: makeSubscription({ status: "active" }) });

    const dropzone = screen.getByTestId("renew-receipt-uploader");
    dropFiles(dropzone, [
      new File(["x"], "note.pdf", { type: "application/pdf" }),
      new File(["y"], "archive.zip", { type: "application/zip" }),
    ]);

    // 非图片被静默过滤，不触发上传。
    expect(mocks.uploadImageFile).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("authorized-image")).toHaveLength(0);
  });

  it("shows drag-over feedback while dragging and clears it on leave", () => {
    renderDialog({ subscription: makeSubscription({ status: "active" }) });

    const dropzone = screen.getByTestId("renew-receipt-uploader");
    fireEvent.dragOver(dropzone);
    expect(dropzone).toHaveAttribute("data-drag-over", "true");

    fireEvent.dragLeave(dropzone);
    expect(dropzone).not.toHaveAttribute("data-drag-over");
  });
});
