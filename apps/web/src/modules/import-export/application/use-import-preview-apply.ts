import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeferredLogoAsset } from "@/components/import-logo-editor";
import {
  recomputePreviewForConflictMode,
  type PreviewFilter,
} from "@/components/import-preview-list";
import { toast } from "@/components/ui/sonner";
import { SETTINGS_QUERY_KEY } from "@/hooks/settings-query-key";
import { invalidateAllSubscriptionBillingRecords, invalidateSubscriptionCollections, removeSubscriptionDetails } from "@/hooks/subscription-query-cache";
import { subscriptionGroupQueryKeys } from "@/hooks/use-subscription-groups";
import { invalidateUploadedAssetsQueries } from "@/hooks/use-uploaded-assets";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import {
  importApplyPayloadSchema,
  importPayloadSchema,
  type ImportApplyResponse,
  type ImportConflictMode,
  type ImportPayload,
  type ImportPreviewResponse,
} from "@/lib/api/schemas/import-export";
import type { PreparedImport } from "@/modules/import-export/domain/import-export-model";
import {
  resolveImportAssets,
  updatePreparedSubscriptionLogo,
} from "@/modules/import-export/domain/wallos-import";
import { importExportService } from "@/services/import-export-service";
import { resolveAutoLogosForPreparedImport } from "@/modules/import-export/domain/auto-logo-resolve";

interface UseImportPreviewApplyOptions {
  onApplied: () => void;
}

function parseApplyPayload(value: unknown): ImportPayload {
  return importPayloadSchema.parse(value) as ImportPayload;
}

function parseApplyResult(value: unknown): ImportApplyResponse {
  return importApplyPayloadSchema.parse(value) as ImportApplyResponse;
}

class ImportAssetUploadError extends Error {
  constructor(readonly cause: unknown) {
    super("IMPORT_ASSET_UPLOAD_FAILED");
    this.name = "ImportAssetUploadError";
  }
}

export function useImportPreviewApply({ onApplied }: UseImportPreviewApplyOptions) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [conflictMode, setConflictMode] = useState<ImportConflictMode>("skip");
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>("all");
  const [skippedIndexes, setSkippedIndexes] = useState<Set<number>>(new Set());
  const [forceReplaceIndexes, setForceReplaceIndexes] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [assetProgress, setAssetProgress] = useState<{ done: number; total: number } | null>(null);
  const [applyProgress, setApplyProgress] = useState<{ done: number; total: number } | null>(null);

  const resetImportPreview = useCallback(() => {
    setPrepared(null);
    setPreview(null);
    setConflictMode("skip");
    setPreviewFilter("all");
    setSkippedIndexes(new Set());
    setForceReplaceIndexes(new Set());
    setError(null);
    setApplying(false);
    setAssetProgress(null);
    setApplyProgress(null);
  }, []);

  const previewPrepared = useCallback(async (
    nextPrepared: PreparedImport,
    nextConflictMode: ImportConflictMode,
    signal: AbortSignal,
  ) => {
    const preparedWithAutoLogos = await resolveAutoLogosForPreparedImport(nextPrepared, signal);
    signal.throwIfAborted();
    const result = await importExportService.preview(preparedWithAutoLogos.payload, nextConflictMode, signal);
    signal.throwIfAborted();
    setPrepared(preparedWithAutoLogos);
    setPreview(result);
    setPreviewFilter("all");
    setSkippedIndexes(new Set());
    setForceReplaceIndexes(new Set());
    setAssetProgress(null);
    setApplyProgress(null);
  }, []);

  const handleConflictModeChange = useCallback((value: ImportConflictMode) => {
    setConflictMode(value);
    // forceReplace 只在 skip 模式有意义；切换到 replace 时所有 existing 默认 replace，清空 forceReplace 避免服务端拒绝。
    if (value === "replace") {
      setForceReplaceIndexes(new Set());
    }
    // 冲突模式只影响已有同源项的 action/summary；预览结果本地重算，执行时服务端仍会重新校验整包。
    setPreview((current) => current ? recomputePreviewForConflictMode(current, value, skippedIndexes, forceReplaceIndexes) : current);
  }, [forceReplaceIndexes, skippedIndexes]);

  const handleLogoChange = useCallback((index: number, value: string | null, asset?: DeferredLogoAsset) => {
    setPrepared((current) => current
      ? updatePreparedSubscriptionLogo(
        current,
        index,
        value,
        asset ? { blob: asset.blob, filename: asset.filename, previewUrl: asset.previewUrl } : undefined,
      )
      : current);
  }, []);

  /**
   * 单按钮切换某一行的生效动作，状态机：
   * - 手动跳过 → 恢复：existing 行在 skip 模式下落到"强制替换"，其余回到模式默认动作；
   * - 强制替换 → 取消：回到 skip 模式默认的跳过；
   * - existing 行 + skip 模式默认（跳过）→ 强制替换；
   * - 其他默认动作（新增 / replace 模式替换）→ 手动跳过。
   */
  const handleToggleRow = useCallback((index: number) => {
    // 强制替换只对可正常导入的 existing 行有意义；错误行（action 恒为 error）只能手动跳过。
    const target = preview?.items.find((item) => item.index === index);
    const canForceReplace = Boolean(target?.existingId) && conflictMode === "skip" && (target?.errors.length ?? 0) === 0;
    const nextSkippedIndexes = new Set(skippedIndexes);
    const nextForceReplaceIndexes = new Set(forceReplaceIndexes);
    if (nextSkippedIndexes.has(index)) {
      nextSkippedIndexes.delete(index);
      if (canForceReplace) {
        nextForceReplaceIndexes.add(index);
      }
    } else if (nextForceReplaceIndexes.has(index)) {
      nextForceReplaceIndexes.delete(index);
    } else if (canForceReplace) {
      nextForceReplaceIndexes.add(index);
    } else {
      nextSkippedIndexes.add(index);
    }
    // 单条切换只改本地预览 action；apply 会携带 skipIndexes/forceReplaceIndexes 让服务端重新预览。
    setSkippedIndexes(nextSkippedIndexes);
    setForceReplaceIndexes(nextForceReplaceIndexes);
    setPreview((current) => current ? recomputePreviewForConflictMode(current, conflictMode, nextSkippedIndexes, nextForceReplaceIndexes) : current);
  }, [conflictMode, forceReplaceIndexes, preview, skippedIndexes]);

  const handleApply = useCallback(async () => {
    if (!prepared || !preview || preview.summary.errors > 0) return;
    setApplying(true);
    setError(null);
    setAssetProgress(null);
    setApplyProgress(null);
    try {
      const skipIndexList = [...skippedIndexes].sort((a, b) => a - b);
      const forceReplaceIndexList = [...forceReplaceIndexes].sort((a, b) => a - b);
      const effectivePreview = recomputePreviewForConflictMode(preview, conflictMode, skippedIndexes, forceReplaceIndexes);
      // 资产上传属于 apply 阶段：预览不产生写入，且 skip 行不会上传 staged/zip Logo。
      const resolvedAssets = await resolveImportAssets(prepared, effectivePreview.items, (done, total) => setAssetProgress({ done, total }))
        .catch((assetError: unknown) => {
          throw new ImportAssetUploadError(assetError);
        });
      const payload = parseApplyPayload(resolvedAssets.payload);
      const result = parseApplyResult(await importExportService.applyChunked(payload, conflictMode, skipIndexList, forceReplaceIndexList, (done, total) => setApplyProgress({ done, total })));
      // 导入资产上传只影响 logo 分页缓存；按上传结果精确失效，避免无 Logo 导入刷新资产列表。
      const assetInvalidations = resolvedAssets.uploadedLogoCount > 0
        ? [invalidateUploadedAssetsQueries(queryClient, "logo")]
        : [];
      const iconAssetInvalidations = resolvedAssets.uploadedIconCount > 0
        ? [invalidateUploadedAssetsQueries(queryClient, "icon")]
        : [];
      // 导入可能同时写订阅、设置和自定义配置；成功后统一失效，避免页面继续展示导入前缓存。
      // 导入可能替换任意 id 的完整记录；detail cache 无法局部证明有效，必须整体清空。
      removeSubscriptionDetails(queryClient);
      await Promise.all([
        invalidateSubscriptionCollections(queryClient),
        queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["custom-config"] }),
        // 恢复分组会整批新建/重绑组（含组 logo）；恢复流水会改写历史扣费记录列表。
        ...(payload.groups?.length
          ? [queryClient.invalidateQueries({ queryKey: subscriptionGroupQueryKeys.all })]
          : []),
        ...(payload.billingRecords?.length
          ? [invalidateAllSubscriptionBillingRecords(queryClient)]
          : []),
        ...assetInvalidations,
        ...iconAssetInvalidations,
      ]);
      toast.success(t("import.successResult", {
          creates: result.summary.creates,
          replaces: result.summary.replaces,
          skips: result.summary.skips,
        }));
      onApplied();
    } catch (err) {
      const message = err instanceof ImportAssetUploadError
        ? t("import.assetUploadFailed")
        : getDisplayErrorMessage(err, t("import.applyFailed"));
      setError(message);
      toast.error(message);
    } finally {
      setApplying(false);
    }
  }, [conflictMode, forceReplaceIndexes, onApplied, prepared, preview, queryClient, skippedIndexes, t]);

  return {
    prepared,
    preview,
    conflictMode,
    previewFilter,
    skippedIndexes,
    forceReplaceIndexes,
    error,
    applying,
    assetProgress,
    applyProgress,
    setError,
    setPreviewFilter,
    resetImportPreview,
    previewPrepared,
    handleConflictModeChange,
    handleLogoChange,
    handleToggleRow,
    handleApply,
  };
}
