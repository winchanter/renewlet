// receipt-uploader 测试聚焦移除凭证的清理契约：
// 会话内上传（未持久化）的凭证移除即调 DELETE 删服务端文件；
// 已持久化凭证移除只更新表单值，文件由服务端在 PATCH 保存时统一 diff 清理。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReceiptUploader } from "./receipt-uploader";

const mocks = vi.hoisted(() => ({
  assetDelete: vi.fn(),
}));

vi.mock("@/services/asset-service", () => ({
  assetService: { delete: mocks.assetDelete },
}));

vi.mock("@/components/authorized-image", () => ({
  AuthorizedImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img src={src} alt={alt} data-testid="authorized-image" />
  ),
}));

vi.mock("@/lib/upload-image", () => ({
  uploadImageFile: vi.fn(),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: (key: string, values?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        "subscription.billingRecords.receipt": "续订凭证",
        "subscription.billingRecords.receiptHint": `可选，最多 ${String(values?.["count"] ?? "")} 张`,
        "subscription.billingRecords.receiptAdd": "添加凭证",
        "subscription.billingRecords.receiptRemove": `移除凭证 ${String(values?.["index"] ?? "")}`,
        "subscription.billingRecords.receiptView": `查看凭证 ${String(values?.["index"] ?? "")}`,
        "subscription.billingRecords.receiptDropHint": "拖拽图片到此处",
        "subscription.billingRecords.receiptsLabel": `凭证 ${String(values?.["count"] ?? "")}/${String(values?.["max"] ?? "")}`,
        "media.uploadFailed": "上传失败",
      };
      return messages[key] ?? key;
    },
  }),
}));

beforeEach(() => {
  mocks.assetDelete.mockReset();
  mocks.assetDelete.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderUploader(value: string[], persistedIds: string[] = []) {
  const onChange = vi.fn();
  render(
    <ReceiptUploader value={value} onChange={onChange} submitting={false} persistedIds={persistedIds} />,
  );
  return onChange;
}

describe("ReceiptUploader remove cleanup", () => {
  it("deletes the server file when removing a session (non-persisted) receipt", async () => {
    const user = userEvent.setup();
    const onChange = renderUploader(["asset-a", "asset-b"]);

    await user.click(screen.getByTestId("renew-receipt-remove-0"));

    expect(onChange).toHaveBeenCalledWith(["asset-b"]);
    expect(mocks.assetDelete).toHaveBeenCalledTimes(1);
    expect(mocks.assetDelete).toHaveBeenCalledWith("asset-a");
  });

  it("does not call delete for persisted receipts; server cleans them on PATCH", async () => {
    const user = userEvent.setup();
    const onChange = renderUploader(["asset-a", "asset-b"], ["asset-a", "asset-b"]);

    await user.click(screen.getByTestId("renew-receipt-remove-1"));

    expect(onChange).toHaveBeenCalledWith(["asset-a"]);
    expect(mocks.assetDelete).not.toHaveBeenCalled();
  });
});
