import { apiFetch } from "@/lib/api-client";
import {
  IMPORT_APPLY_SUBSCRIPTION_LIMIT,
  importApplyPayloadSchema,
  importApplyResponseSchema,
  importPreviewResponseSchema,
  type ImportApplyResponse,
  type ImportConflictMode,
  type ImportPayload,
  type ImportPreviewItem,
  type ImportPreviewResponse,
} from "@/lib/api/schemas/import-export";

/**
 * 导入导出服务。
 *
 * preview 和 apply 都由后端重新计算冲突；前端分块只解决请求体/事务上限，不改变幂等语义。
 */
export const importExportService = {
  async preview(
    payload: ImportPayload,
    conflictMode: ImportConflictMode,
    signal: AbortSignal,
    skipIndexes: readonly number[] = [],
    forceReplaceIndexes: readonly number[] = [],
  ): Promise<ImportPreviewResponse> {
    return await apiFetch("/api/app/import/preview", importPreviewResponseSchema, {
      method: "POST",
      body: JSON.stringify({ payload, conflictMode, skipIndexes, forceReplaceIndexes }),
      signal,
    });
  },

  async apply(payload: ImportPayload, conflictMode: ImportConflictMode, skipIndexes: readonly number[] = [], forceReplaceIndexes: readonly number[] = []): Promise<ImportApplyResponse> {
    return await applyImportPayload(payload, conflictMode, skipIndexes, forceReplaceIndexes);
  },

  async applyChunked(
    payload: ImportPayload,
    conflictMode: ImportConflictMode,
    skipIndexes: readonly number[] = [],
    forceReplaceIndexes: readonly number[] = [],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ImportApplyResponse> {
    if (payload.subscriptions.length <= IMPORT_APPLY_SUBSCRIPTION_LIMIT) {
      const result = await applyImportPayload(payload, conflictMode, skipIndexes, forceReplaceIndexes);
      onProgress?.(payload.subscriptions.length, payload.subscriptions.length);
      return result;
    }

    // Docker 与 Cloudflare 共享 200 条 apply 上限；顺序切包靠 extra.import 幂等键支持失败后重试收敛。
    const chunks = chunkSubscriptions(payload.subscriptions, IMPORT_APPLY_SUBSCRIPTION_LIMIT);
    if (chunks.length === 0) {
      return await applyImportPayload(payload, conflictMode, [], []);
    }
    const items: ImportPreviewItem[] = [];
    const summary = { total: 0, creates: 0, replaces: 0, skips: 0, errors: 0, warnings: 0 };
    let done = 0;
    onProgress?.(done, payload.subscriptions.length);

    for (let index = 0; index < chunks.length; index += 1) {
      const offset = index * IMPORT_APPLY_SUBSCRIPTION_LIMIT;
      const chunk = chunks[index] ?? [];
      const chunkPayload: ImportPayload = {
        source: payload.source,
        subscriptions: chunk,
        // 分组必须先于任何订阅落库（订阅保存时即重绑组），所以只放第一块。
        ...(index === 0 && payload.groups ? { groups: payload.groups } : {}),
        ...(index === chunks.length - 1 && payload.settings ? { settings: payload.settings } : {}),
        ...(index === chunks.length - 1 && payload.customConfig ? { customConfig: payload.customConfig } : {}),
        ...(index === chunks.length - 1 && payload.exchangeRateSnapshots ? { exchangeRateSnapshots: payload.exchangeRateSnapshots } : {}),
        // 流水依赖全部订阅就绪：此时前序分块的订阅已按 renewlet:源ID 成为库内精确匹配，宿主映射完整。
        ...(index === chunks.length - 1 && payload.billingRecords ? { billingRecords: payload.billingRecords } : {}),
      };
      const chunkSkipIndexes = skipIndexes
        .filter((itemIndex) => itemIndex >= offset && itemIndex < offset + chunk.length)
        .map((itemIndex) => itemIndex - offset);
      const chunkForceReplaceIndexes = forceReplaceIndexes
        .filter((itemIndex) => itemIndex >= offset && itemIndex < offset + chunk.length)
        .map((itemIndex) => itemIndex - offset);
      const result = await applyImportPayload(chunkPayload, conflictMode, chunkSkipIndexes, chunkForceReplaceIndexes);
      summary.total += result.summary.total;
      summary.creates += result.summary.creates;
      summary.replaces += result.summary.replaces;
      summary.skips += result.summary.skips;
      summary.errors += result.summary.errors;
      summary.warnings += result.summary.warnings;
      items.push(...result.items.map((item) => ({ ...item, index: item.index + offset })));
      done += chunkPayload.subscriptions.length;
      onProgress?.(done, payload.subscriptions.length);
    }

    return importApplyPayloadSchema.parse({
      summary,
      items,
      includesSettings: Boolean(payload.settings),
      includesCustomConfig: Boolean(payload.customConfig),
      includesExchangeRateSnapshots: Boolean(payload.exchangeRateSnapshots?.length),
      exchangeRateSnapshotsCount: payload.exchangeRateSnapshots?.length ?? 0,
      includesGroups: Boolean(payload.groups?.length),
      groupsCount: payload.groups?.length ?? 0,
      includesBillingRecords: Boolean(payload.billingRecords?.length),
      billingRecordsCount: payload.billingRecords?.length ?? 0,
    });
  },
};

async function applyImportPayload(payload: ImportPayload, conflictMode: ImportConflictMode, skipIndexes: readonly number[] = [], forceReplaceIndexes: readonly number[] = []): Promise<ImportApplyResponse> {
  // apply 可能写入订阅、设置和自定义配置，超时放宽到导入事务可完成的范围。
  return await apiFetch("/api/app/import/apply", importApplyResponseSchema, {
    method: "POST",
    body: JSON.stringify({ payload, conflictMode, skipIndexes, forceReplaceIndexes }),
    timeoutMs: 60_000,
  });
}

function chunkSubscriptions<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
