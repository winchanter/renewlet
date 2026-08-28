// billing-records-dialog 测试聚焦凭证编辑链路：进入编辑后展示既有凭证、上传新凭证、移除凭证，
// 以及对应 PATCH payload 是否正确携带 receiptAssetIds。其余字段编辑已在 renew 链路覆盖。
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { ApiBillingRecord } from "@renewlet/shared/schemas/billing-records";
import type { SubscriptionCollectionItem } from "@/types/subscription";
import { BillingRecordsDialogContent } from "./billing-records-dialog";

const mocks = vi.hoisted(() => ({
  uploadImageFile: vi.fn(),
  useBillingRecords: vi.fn(),
  useUpdateBillingRecord: vi.fn(),
}));

vi.mock("@/lib/upload-image", () => ({
  uploadImageFile: mocks.uploadImageFile,
}));

vi.mock("@/components/authorized-image", () => ({
  AuthorizedImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img src={src} alt={alt} data-testid="authorized-image" />
  ),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-billing-records", () => ({
  useBillingRecords: mocks.useBillingRecords,
  useUpdateBillingRecord: mocks.useUpdateBillingRecord,
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfigState: () => ({
    config: {
      currencies: [
        { id: "USD", value: "USD", labels: { "zh-CN": "$ 美元 (USD)", "en-US": "$ US Dollar (USD)" }, enabled: true },
      ],
    },
  }),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string, values?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        "common.cancel": "取消",
        "common.save": "保存",
        "common.edit": "编辑",
        "common.loading": "加载中",
        "error.generic": "操作失败",
        "subscription.billingRecords.title": "扣费记录",
        "subscription.billingRecords.empty": "暂无记录",
        "subscription.billingRecords.metaCount": `共 ${String(values?.["count"] ?? "")} 条`,
        "subscription.billingRecords.metaTotal": `合计 ${String(values?.["amount"] ?? "")}`,
        "subscription.billingRecords.loadMore": "加载更多",
        "subscription.billingRecords.billingDate": "扣费日",
        "subscription.billingRecords.periodHint": "编辑周期将重算覆盖区间。",
        "subscription.billingRecords.updated": "已更新",
        "subscription.billingRecords.modeInitial": "首期",
        "subscription.billingRecords.modeAuto": "自动",
        "subscription.billingRecords.modeManual": "手动",
        "subscription.billingRecords.receipt": "续订凭证",
        "subscription.billingRecords.receiptHint": `可选，最多 ${String(values?.["count"] ?? "")} 张`,
        "subscription.billingRecords.receiptAdd": "添加凭证",
        "subscription.billingRecords.receiptRemove": `移除凭证 ${String(values?.["index"] ?? "")}`,
        "subscription.billingRecords.receiptView": `查看凭证 ${String(values?.["index"] ?? "")}`,
        "subscription.billingRecords.receiptDropHint": "拖拽图片到此处",
        "subscription.billingRecords.receiptsLabel": `凭证 ${String(values?.["count"] ?? "")}/${String(values?.["max"] ?? "")}`,
        "media.uploadFailed": "上传失败",
        "subscription.field.price": "价格",
        "subscription.field.currency": "货币",
        "subscription.field.billingCycle": "周期",
        "subscription.field.customDays": "自定义天数",
        "subscription.field.customCycleUnit": "单位",
        "subscription.field.oneTimeTerm": "服务期数",
        "subscription.field.oneTimeTermUnit": "服务期单位",
        "subscription.field.usageTotal": "总量",
        "subscription.field.usageDailyRate": "日均",
        "subscription.field.usageUnit": "单位",
        "subscription.placeholder.currency": "选择货币",
        "subscription.placeholder.date": "选择日期",
        "subscription.search.currency": "搜索货币",
        "subscription.empty.currency": "未找到货币",
        "subscription.cycle.monthly": "每月",
        "subscription.cycle.yearly": "每年",
        "subscription.cycle.custom": "自定义",
        "subscription.cycle.oneTime": "一次性",
        "subscription.cycle.usageBased": "按量",
        "subscription.customCycleUnit.day": "天",
        "subscription.customCycleUnit.week": "周",
        "subscription.customCycleUnit.month": "月",
      };
      return messages[key] ?? key;
    },
    label: (labelSet: Record<string, string>) => labelSet?.["zh-CN"] ?? labelSet?.["en-US"] ?? "",
    translate: (_locale: string, key: string) => key,
    formatCurrency: (value: number, _currency: string) => String(value),
    formatDateOnly: (value: string) => value,
    formatDateTime: (value: Date | string) => (typeof value === "string" ? value : value.toISOString()),
  }),
}));

beforeEach(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false);
  Element.prototype.setPointerCapture ??= vi.fn();
  Element.prototype.releasePointerCapture ??= vi.fn();
  mocks.uploadImageFile.mockReset();
  mocks.useBillingRecords.mockReset();
  mocks.useUpdateBillingRecord.mockReset();
  mocks.uploadImageFile.mockResolvedValue({ url: "/api/app/assets/receipt-1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setupUser() {
  return userEvent.setup();
}

function apiRecord(overrides: Partial<ApiBillingRecord> = {}): ApiBillingRecord {
  return {
    id: "record-1",
    subscriptionId: "sub-1",
    name: "Service",
    billingDate: "2026-01-01",
    periodEndDate: "2026-02-01",
    amount: "10",
    currency: "USD",
    mode: "initial",
    billingCycle: "monthly",
    receiptAssetIds: [],
    ...overrides,
  };
}

const collectionItem = {
  id: "sub-1",
  name: "Service",
  logo: undefined,
} as unknown as SubscriptionCollectionItem;

interface UpdateRecordMock {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
}

function renderDialog(record: ApiBillingRecord, updateMock?: Partial<UpdateRecordMock>) {
  const mutateAsync = updateMock?.mutateAsync ?? vi.fn(async (input: { recordId: string; patch: Record<string, unknown> }) => {
    return { ...record, ...input.patch } as ApiBillingRecord;
  });
  mocks.useBillingRecords.mockReturnValue({
    records: [record],
    total: 1,
    hasNextPage: false,
    isPending: false,
    isError: false,
    error: null,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  });
  mocks.useUpdateBillingRecord.mockReturnValue({
    mutateAsync,
    isPending: updateMock?.isPending ?? false,
    mutate: vi.fn(),
    isIdle: true,
    isError: false,
    isPending: false,
    isPaused: false,
    isSuccess: false,
    reset: vi.fn(),
    context: {},
    data: undefined,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPending: updateMock?.isPending ?? false,
    submittedAt: 0,
    variables: undefined,
  });
  return render(
    <TooltipProvider>
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          closeLabel="关闭"
          dismissMode="explicit"
          layout="content"
          className="h5-dialog-auto-frame gap-0 border-border bg-card p-0 sm:max-w-lg"
        >
          <BillingRecordsDialogContent
            collectionItem={collectionItem}
            open
            onOpenChange={() => {}}
          />
        </DialogContent>
      </Dialog>
    </TooltipProvider>,
  );
}

describe("BillingRecordEditForm receipts", () => {
  it("shows existing receipts as thumbnails when entering edit mode", async () => {
    const user = setupUser();
    renderDialog(apiRecord({ receiptAssetIds: ["existing-1", "existing-2"] }));

    // 展开态：既有凭证缩略图直接渲染（编辑态下 BillingRecordReceipts 不显示，由 ReceiptUploader 接管）。
    await user.click(screen.getByTestId("billing-record-edit-toggle-record-1"));

    const uploader = screen.getByTestId("billing-record-receipt-record-1-uploader");
    expect(uploader).toBeInTheDocument();
    expect(screen.getAllByTestId("authorized-image")).toHaveLength(2);
    expect(screen.getByText("凭证 2/6")).toBeInTheDocument();
  });

  it("uploads a new receipt in edit mode and includes it in the PATCH payload", async () => {
    const user = setupUser();
    mocks.uploadImageFile.mockResolvedValueOnce({ url: "/api/app/assets/new-1" });
    renderDialog(apiRecord({ receiptAssetIds: ["existing-1"] }));

    await user.click(screen.getByTestId("billing-record-edit-toggle-record-1"));

    const fileInput = screen.getByTestId("billing-record-receipt-record-1-input");
    await user.upload(fileInput, [new File(["a"], "new.png", { type: "image/png" })]);

    await waitFor(() => expect(mocks.uploadImageFile).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId("authorized-image")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "保存" }));

    const updateMock = mocks.useUpdateBillingRecord();
    await waitFor(() => expect(updateMock.mutateAsync).toHaveBeenCalledTimes(1));
    const arg = updateMock.mutateAsync.mock.calls[0]?.[0] as { recordId: string; patch: Record<string, unknown> };
    expect(arg.recordId).toBe("record-1");
    expect(arg.patch.receiptAssetIds).toEqual(["existing-1", "new-1"]);
  });

  it("removes an existing receipt in edit mode and excludes it from the PATCH payload", async () => {
    const user = setupUser();
    renderDialog(apiRecord({ receiptAssetIds: ["keep-1", "drop-1"] }));

    await user.click(screen.getByTestId("billing-record-edit-toggle-record-1"));

    await user.click(screen.getByTestId("billing-record-receipt-record-1-remove-1"));

    expect(screen.getAllByTestId("authorized-image")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "保存" }));

    const updateMock = mocks.useUpdateBillingRecord();
    await waitFor(() => expect(updateMock.mutateAsync).toHaveBeenCalledTimes(1));
    const arg = updateMock.mutateAsync.mock.calls[0]?.[0] as { recordId: string; patch: Record<string, unknown> };
    expect(arg.patch.receiptAssetIds).toEqual(["keep-1"]);
  });

  it("does not call PATCH when receipts are unchanged and no other field is edited", async () => {
    const user = setupUser();
    renderDialog(apiRecord({ receiptAssetIds: ["keep-1"] }));

    await user.click(screen.getByTestId("billing-record-edit-toggle-record-1"));

    // 既有凭证渲染但未改动：保存应直接收起，不发起空 PATCH。
    await user.click(screen.getByRole("button", { name: "保存" }));

    const updateMock = mocks.useUpdateBillingRecord();
    await waitFor(() => expect(updateMock.mutateAsync).not.toHaveBeenCalled());
  });
});
