/**
 * 续订凭证多图上传组件。
 *
 * 架构位置：
 * - 续订弹窗（renew-subscription-dialog）和历史记录编辑表单（billing-records-dialog）共用此组件。
 * - 上传走 uploadImageFile（kind="receipt"），返回 /api/app/assets/{id} 受控路径，前端只持久化 id。
 *
 * 状态链路：
 * ```
 * 文件选择/拖拽 -> 过滤非图片 + 截断到 remaining -> 顺序上传 -> onChange 追加 id 列表
 * ```
 * canAddMore=false（提交中/上传中/已满 6 张）时静默忽略拖拽，避免覆盖进行中的状态。
 */
import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { AuthorizedImage } from "@/components/authorized-image";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useI18n } from "@/i18n/I18nProvider";
import { buildPrivateAssetUrl, parsePrivateAssetId } from "@/lib/logo-url";
import { uploadImageFile } from "@/lib/upload-image";
import { assetService } from "@/services/asset-service";
import { RECEIPT_ASSET_IDS_MAX } from "@renewlet/shared/runtime";

export interface ReceiptUploaderProps {
  value: string[];
  onChange: (ids: string[]) => void;
  submitting: boolean;
  /**
   * 已持久化到扣费记录的凭证 id；这些 id 被移除时不走前端删除接口，
   * 由服务端在 PATCH 保存时统一 diff 清理（避免取消编辑后文件已被误删）。
   * 默认空数组：续订弹窗里的凭证全是本次会话上传，移除即删。
   */
  persistedIds?: string[];
  /**
   * data-testid 与 FormField id 的前缀。
   * 续订弹窗用默认 "renew-receipt"；历史记录编辑表单每行用 "billing-record-receipt-{recordId}"
   * 保证多行同时编辑时 id 与 testid 唯一。
   */
  testIdPrefix?: string;
}

export function ReceiptUploader({ value, onChange, submitting, persistedIds = [], testIdPrefix = "renew-receipt" }: ReceiptUploaderProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const remaining = RECEIPT_ASSET_IDS_MAX - value.length;
  const canAddMore = remaining > 0 && uploadingCount === 0 && !submitting;

  const handleFiles = useCallback(async (files: File[]) => {
    // 只接受图片，非图片（如 PDF/zip）静默过滤；超出 remaining 的部分截断，不报错。
    const picked = files
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, remaining);
    if (picked.length === 0) return;
    setUploadError(null);
    setUploadingCount((current) => current + picked.length);
    try {
      const collected: string[] = [];
      for (const file of picked) {
        const result = await uploadImageFile({ file, kind: "receipt" });
        const id = parsePrivateAssetId(result.url);
        if (!id) {
          throw new Error(t("media.uploadFailed"));
        }
        collected.push(id);
      }
      onChange([...value, ...collected]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : t("media.uploadFailed"));
    } finally {
      setUploadingCount(0);
      // 清空 input.value，允许用户连续选同一文件重试。
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [onChange, remaining, t, value]);

  const removeAt = useCallback((index: number) => {
    setUploadError(null);
    const removedId = value[index];
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
    // 会话内上传（未持久化）的凭证移除即删服务端文件；持久化凭证交由 PATCH 保存时服务端 diff 清理。
    if (removedId && !persistedIds.includes(removedId)) {
      void assetService.delete(removedId).catch(() => {
        // 清理失败保留孤儿资产，不阻塞用户操作；存储回收由服务端兜底。
      });
    }
  }, [onChange, persistedIds, value]);

  // 整个上传区作为 dropzone：canAddMore=false 时静默忽略，避免提交中/上传中/已满被覆盖。
  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (canAddMore && !dragOver) setDragOver(true);
  }, [canAddMore, dragOver]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // relatedTarget 落在 dropzone 内部（如缩略图）时不清除高亮，避免在子元素间移动闪烁。
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (!canAddMore) return;
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    void handleFiles(dropped);
  }, [canAddMore, handleFiles]);

  return (
    <FormField
      id={testIdPrefix}
      label={t("subscription.billingRecords.receipt")}
      description={t("subscription.billingRecords.receiptHint", { count: RECEIPT_ASSET_IDS_MAX })}
    >
      {() => (
        <div
          className={`grid gap-2 rounded-md border border-dashed p-1.5 transition-colors${
            dragOver
              ? " border-ring bg-secondary/30 ring-2 ring-ring/50"
              : " border-transparent"
          }`}
          data-testid={`${testIdPrefix}-uploader`}
          data-drag-over={dragOver || undefined}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {value.length === 0 && uploadingCount === 0 ? (
            <p className="text-xs text-muted-foreground">{t("subscription.billingRecords.receiptDropHint")}</p>
          ) : null}
          {value.length > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid={`${testIdPrefix}-list`}>
              {value.map((assetId, index) => (
                <li
                  key={assetId}
                  className="group relative aspect-square overflow-hidden rounded-md border border-border bg-secondary"
                >
                  <AuthorizedImage
                    src={buildPrivateAssetUrl(assetId)}
                    alt={t("subscription.billingRecords.receiptView", { index: index + 1 })}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <button
                    type="button"
                    onClick={() => removeAt(index)}
                    disabled={submitting}
                    aria-label={t("subscription.billingRecords.receiptRemove", { index: index + 1 })}
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm transition-colors hover:bg-background focus-visible:bg-background"
                    data-testid={`${testIdPrefix}-remove-${index}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
              {uploadingCount > 0 ? Array.from({ length: uploadingCount }).map((_, idx) => (
                <li
                  key={`${testIdPrefix}-uploading-${idx}`}
                  className="flex aspect-square items-center justify-center rounded-md border border-dashed border-border bg-secondary/50"
                  aria-hidden="true"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </li>
              )) : null}
            </ul>
          ) : uploadingCount > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-hidden="true">
              {Array.from({ length: uploadingCount }).map((_, idx) => (
                <li
                  key={`${testIdPrefix}-uploading-${idx}`}
                  className="flex aspect-square items-center justify-center rounded-md border border-dashed border-border bg-secondary/50"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </li>
              ))}
            </ul>
          ) : null}
          {canAddMore ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                onChange={(event) => {
                  if (event.target.files && event.target.files.length > 0) {
                    void handleFiles(Array.from(event.target.files));
                  }
                }}
                data-testid={`${testIdPrefix}-input`}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-center border-border sm:w-auto"
                onClick={() => fileInputRef.current?.click()}
                data-testid={`${testIdPrefix}-add`}
              >
                <ImagePlus className="mr-1.5 h-4 w-4" />
                {t("subscription.billingRecords.receiptAdd")}
              </Button>
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("subscription.billingRecords.receiptsLabel", { count: value.length, max: RECEIPT_ASSET_IDS_MAX })}
          </p>
          {uploadError ? (
            <p className="text-sm text-destructive" role="alert" data-testid={`${testIdPrefix}-error`}>
              {uploadError}
            </p>
          ) : null}
        </div>
      )}
    </FormField>
  );
}
