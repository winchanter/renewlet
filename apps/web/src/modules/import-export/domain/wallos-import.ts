import { importPayloadSchema, renewletExportV1Schema, type ImportPayload, type ImportPreviewItem } from "@renewlet/shared/schemas/import-export";
import { runWorkerJob } from "@/lib/workers/run-worker-job";
import type { ImportBuildBaseContext } from "./wallos-import-mapping";
import {
  buildFromRenewletExport,
  buildFromWallosDisplayRows,
  buildFromWallosRows,
  isWallosApiPayload,
  isWallosDisplayPayload,
  isWallosDisplayRows,
  rowsById,
  wallosUsersFromApiPayload,
  type WallosTableRow,
} from "./wallos-import-mapping";
import {
  IMPORT_MESSAGE_CODES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_PREVIEW_SUBSCRIPTIONS,
  type ImportAssetRef,
  type ImportLogoAutoMatch,
  type PreparedImport,
  privateAssetIdFromLogo,
} from "./import-export-model";
import { assetService } from "@/services/asset-service";
import type { WallosImportWorkerPayload, WallosImportWorkerResult } from "./wallos-import-worker-contract";

type ImportSubscription = ImportPayload["subscriptions"][number];

export interface ResolvedImportAssets {
  payload: ImportPayload;
  uploadedLogoCount: number;
  uploadedIconCount: number;
}

/**
 * parseImportFile 将用户选择的 Renewo/Wallos 文件转换为待预览导入模型。
 *
 * 大文件只在浏览器本地解析或交给 Worker，不把用户的 Wallos 备份上传到服务端做格式探测。
 *
 * @param file 用户显式选择的 JSON/ZIP/SQLite 文件。
 * @param context 当前自定义配置与默认值映射上下文。
 * @param wallosUserId Wallos 多用户备份中被导入的用户 ID；未传时使用首个用户。
 */
export async function parseImportFile(
  file: File,
  context: ImportBuildBaseContext,
  wallosUserId?: string,
  maxFileBytes = MAX_IMPORT_FILE_BYTES,
  signal?: AbortSignal,
): Promise<PreparedImport> {
  if (file.size > maxFileBytes) throw new Error(IMPORT_MESSAGE_CODES.fileTooLarge);
  const buffer = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException("Import parsing cancelled", "AbortError");
  const bytes = new Uint8Array(buffer);
  if (isZipBytes(bytes) || isSqliteBytes(bytes)) {
    return await parseHeavyFileInWorker(buffer, context, wallosUserId, maxFileBytes, signal);
  }
  return parseJsonText(new TextDecoder().decode(bytes), context);
}

/**
 * parseJsonText 解析纯文本导入内容。
 *
 * Renewo export v1 是唯一自导入格式；Wallos 分支只做外部备份字段映射。
 */
export async function parseJsonText(
  text: string,
  context: ImportBuildBaseContext,
  wallosUserId?: string,
): Promise<PreparedImport> {
  if (text.length > MAX_IMPORT_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new Error(IMPORT_MESSAGE_CODES.fileTooLarge);
  }
  const parsed = JSON.parse(text) as unknown;
  const renewletExport = renewletExportV1Schema.safeParse(parsed);
  if (renewletExport.success) {
    assertPreviewSubscriptionCount(renewletExport.data.data.subscriptions.length);
    return buildFromRenewletExport(renewletExport.data, context);
  }
  if (isWallosApiPayload(parsed)) {
    assertPreviewSubscriptionCount(parsed.subscriptions.length);
    const users = wallosUsersFromApiPayload(parsed);
    const selectedUserId = wallosUserId ?? users[0]?.id;
    const rows = selectedUserId
      ? parsed.subscriptions.filter((row) => row["user_id"] === undefined || String(row["user_id"]) === selectedUserId)
      : parsed.subscriptions;
    return buildFromWallosRows(rows, context, {
      users,
      // Wallos 各 API 端点是分开的；若用户把 subscriptions 与 currencies/categories 等响应合并粘贴，必须按同一批 ID 精确映射，不能退回默认 ID 表。
      currencies: rowsById(optionalRows(parsed.currencies)),
      categories: rowsById(optionalRows(parsed.categories)),
      paymentMethods: rowsById(optionalRows(parsed.payment_methods ?? parsed.paymentMethods)),
      members: rowsById(optionalRows(parsed.household ?? parsed.members)),
      logoFiles: new Map(),
    });
  }
  if (isWallosDisplayRows(parsed)) {
    assertPreviewSubscriptionCount(parsed.length);
    return buildFromWallosDisplayRows(parsed, context);
  }
  if (isWallosDisplayPayload(parsed)) {
    assertPreviewSubscriptionCount(parsed.subscriptions.length);
    return buildFromWallosDisplayRows(parsed.subscriptions, context);
  }
  throw new Error(IMPORT_MESSAGE_CODES.unrecognizedFile);
}

function assertPreviewSubscriptionCount(count: number): void {
  if (count > MAX_IMPORT_PREVIEW_SUBSCRIPTIONS) {
    throw new Error(IMPORT_MESSAGE_CODES.fileTooLarge);
  }
}

/**
 * updatePreparedSubscriptionLogo 写入单条预览项的 Logo 覆盖。
 *
 * 导入资产引用与 payload logo 字段必须一起移动，避免用户在预览里替换 Logo 后仍上传旧 ZIP entry。
 */
export function updatePreparedSubscriptionLogo(
  prepared: PreparedImport,
  index: number,
  value: string | null,
  asset?: Omit<ImportAssetRef, "target" | "kind">,
): PreparedImport {
  if (!prepared.payload.subscriptions[index]) return prepared;
  const nextAssets = prepared.assets.filter((item) => item.target.type !== "subscriptionLogo" || item.target.subscriptionIndex !== index);
  if (asset) nextAssets.push({ ...asset, target: { type: "subscriptionLogo", subscriptionIndex: index }, kind: "logo" });
  const logoOverrides: ReadonlyMap<number, string | null> = new Map<number, string | null>([[index, value]]);
  const nextPrepared = updatePreparedSubscriptionLogos(prepared, logoOverrides);
  return {
    ...nextPrepared,
    assets: nextAssets,
  };
}

/**
 * updatePreparedSubscriptionLogos 批量写入 Logo 覆盖并维护自动匹配来源。
 *
 * auto match 只保留仍等于当前覆盖值的项；用户手动修改后不再把它当作自动匹配结果展示。
 */
export function updatePreparedSubscriptionLogos(
  prepared: PreparedImport,
  logoOverrides: ReadonlyMap<number, string | null>,
  autoMatches: readonly ImportLogoAutoMatch[] = [],
): PreparedImport {
  if (logoOverrides.size === 0) return prepared;
  const payload = buildPayloadWithLogoOverrides(prepared.payload, logoOverrides);
  const changedIndexes = new Set(logoOverrides.keys());
  const retainedAutoMatches = (prepared.logoAutoMatches ?? []).filter((match) => !changedIndexes.has(match.subscriptionIndex));
  const nextAutoMatches = [
    ...retainedAutoMatches,
    ...autoMatches.filter((match) => logoOverrides.get(match.subscriptionIndex) === match.url),
  ];
  const { logoAutoMatches: _logoAutoMatches, ...preparedWithoutAutoMatches } = prepared;
  if (nextAutoMatches.length === 0) {
    return {
      ...preparedWithoutAutoMatches,
      payload,
    };
  }
  return {
    ...preparedWithoutAutoMatches,
    payload,
    logoAutoMatches: nextAutoMatches,
  };
}

/**
 * ZIP/SQLite Worker 已在返回前提取全部被引用资产；主线程只从已转移的 buffer 构造上传 Blob。
 */
export async function loadImportAssetBlob(asset: ImportAssetRef): Promise<Blob> {
  if (asset.blob) return asset.blob;
  if (!asset.buffer || !asset.mimeType) throw new Error("Import asset is not available.");
  return new Blob([asset.buffer], { type: asset.mimeType });
}

/**
 * resolveImportAssets 上传预览中最终会写入的私有资产，并把 payload 改写为受控资产 URL。
 *
 * 服务端 apply 只能恢复受控代理路径；ZIP 内 `assets/...` 不能裸写入订阅或自定义配置。
 */
export async function resolveImportAssets(
  prepared: PreparedImport,
  previewItems: ImportPreviewItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<ResolvedImportAssets> {
  const writableIndexes = new Set(previewItems.filter((item) => item.action === "create" || item.action === "replace").map((item) => item.index));
  const assets = prepared.assets.filter((asset) => importAssetWillBeWritten(prepared, writableIndexes, asset));
  if (assets.length === 0) return { payload: prepared.payload, uploadedLogoCount: 0, uploadedIconCount: 0 };
  const logoOverrides = new Map<number, string | null>();
  const iconOverrides = new Map<number, string>();
  const groupLogoOverrides = new Map<number, string>();
  // 凭证重写按“流水下标 → (备份内资产 ID → 新实例资产 ID)”组织；同一资产被多条流水引用时只上传一次。
  const receiptOverrides = new Map<number, Map<string, string>>();
  let done = 0;
  onProgress?.(done, assets.length);
  // 上传并发限制保护 Cloudflare R2/D1 与 PocketBase collection；导入几百个私有图标时不能无界占满浏览器连接。
  await runWithConcurrency(assets, 3, async (asset) => {
    const blob = await loadImportAssetBlob(asset);
    const uploaded = await assetService.create(blob, asset.kind, asset.filename);
    if (asset.target.type === "subscriptionLogo") {
      logoOverrides.set(asset.target.subscriptionIndex, uploaded.url);
    } else if (asset.target.type === "paymentMethodIcon") {
      iconOverrides.set(asset.target.paymentMethodIndex, uploaded.url);
    } else if (asset.target.type === "groupLogo") {
      groupLogoOverrides.set(asset.target.groupIndex, uploaded.url);
    } else {
      // receiptAssetIds 存的是资产 ID（不是代理路径）：从上传响应 URL 解析新 ID 后按源 ID 建替换映射。
      const newAssetId = privateAssetIdFromLogo(uploaded.url);
      if (newAssetId) {
        const perRecord = receiptOverrides.get(asset.target.billingRecordIndex) ?? new Map<string, string>();
        perRecord.set(asset.target.assetId, newAssetId);
        receiptOverrides.set(asset.target.billingRecordIndex, perRecord);
      }
    }
    done += 1;
    onProgress?.(done, assets.length);
  });
  return {
    payload: buildPayloadWithAssetOverrides(prepared.payload, logoOverrides, iconOverrides, groupLogoOverrides, receiptOverrides),
    // 组 logo 与订阅 logo 同属 logo 类缓存失效口径。
    uploadedLogoCount: logoOverrides.size + groupLogoOverrides.size,
    uploadedIconCount: iconOverrides.size,
  };
}

function importAssetWillBeWritten(prepared: PreparedImport, writableIndexes: ReadonlySet<number>, asset: ImportAssetRef): boolean {
  if (asset.target.type === "subscriptionLogo") {
    return writableIndexes.has(asset.target.subscriptionIndex) && Boolean(prepared.payload.subscriptions[asset.target.subscriptionIndex]);
  }
  if (asset.target.type === "paymentMethodIcon") {
    return Boolean(prepared.payload.customConfig?.paymentMethods[asset.target.paymentMethodIndex]);
  }
  if (asset.target.type === "groupLogo") {
    // 分组整批重建，没有单条 skip 概念：payload 中存在该下标即上传。
    return Boolean(prepared.payload.groups?.[asset.target.groupIndex]);
  }
  // 凭证只要随包记录存在就上传：前端无法预知服务端宿主映射（existing 订阅即使 action=skip，
  // 其流水仍会挂到库内既有订阅）。真正无宿主的流水由服务端整行丢弃，凭证不会悬挂。
  return Boolean(prepared.payload.billingRecords?.[asset.target.billingRecordIndex]);
}

async function parseHeavyFileInWorker(
  buffer: ArrayBuffer,
  context: ImportBuildBaseContext,
  wallosUserId?: string,
  maxFileBytes = MAX_IMPORT_FILE_BYTES,
  signal?: AbortSignal,
): Promise<PreparedImport> {
  // ZIP/SQLite 只在用户显式选择文件后转移给 Worker；buffer 发出后主线程不再拥有其内容。
  return await runWorkerJob<WallosImportWorkerPayload, WallosImportWorkerResult>({
    createWorker: () => new Worker(new URL("./wallos-import-worker.ts", import.meta.url), { type: "module" }),
    payload: { buffer, context, maxFileBytes, ...(wallosUserId ? { wallosUserId } : {}) },
    transfer: [buffer],
    ...(signal ? { signal } : {}),
  });
}

function buildPayloadWithLogoOverrides(payload: ImportPayload, logoOverrides: ReadonlyMap<number, string | null>): ImportPayload {
  if (logoOverrides.size === 0) return payload;
  const subscriptions = payload.subscriptions.map((subscription, index): ImportSubscription => (
    logoOverrides.has(index)
      ? { ...subscription, logo: logoOverrides.get(index) ?? null }
      : subscription
  ));
  return importPayloadSchema.parse({ ...payload, subscriptions });
}

function buildPayloadWithAssetOverrides(
  payload: ImportPayload,
  logoOverrides: ReadonlyMap<number, string | null>,
  iconOverrides: ReadonlyMap<number, string>,
  groupLogoOverrides: ReadonlyMap<number, string>,
  receiptOverrides: ReadonlyMap<number, ReadonlyMap<string, string>>,
): ImportPayload {
  let nextPayload = buildPayloadWithLogoOverrides(payload, logoOverrides);
  if (iconOverrides.size > 0 && nextPayload.customConfig) {
    const customConfig = {
      ...nextPayload.customConfig,
      paymentMethods: nextPayload.customConfig.paymentMethods.map((item, index) => {
        const icon = iconOverrides.get(index);
        return icon === undefined ? item : { ...item, icon };
      }),
    };
    nextPayload = { ...nextPayload, customConfig };
  }
  if (groupLogoOverrides.size > 0 && nextPayload.groups) {
    const groups = nextPayload.groups.map((group, index) => {
      const logo = groupLogoOverrides.get(index);
      return logo === undefined ? group : { ...group, logo };
    });
    nextPayload = { ...nextPayload, groups };
  }
  if (receiptOverrides.size > 0 && nextPayload.billingRecords) {
    const billingRecords = nextPayload.billingRecords.map((record, index) => {
      const replacements = receiptOverrides.get(index);
      if (!replacements) return record;
      // 未取得新 ID（宿主被 skip 等）的源资产 ID 直接移除，绝不把旧实例 ID 写进新库。
      const receiptAssetIds = record.receiptAssetIds
        .map((assetId) => replacements.get(assetId))
        .filter((assetId): assetId is string => Boolean(assetId));
      return { ...record, receiptAssetIds };
    });
    nextPayload = { ...nextPayload, billingRecords };
  }
  return importPayloadSchema.parse(nextPayload);
}

function optionalRows(value: unknown): WallosTableRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is WallosTableRow => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function isSqliteBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  return new TextDecoder().decode(bytes.slice(0, 16)) === "SQLite format 3\0";
}
