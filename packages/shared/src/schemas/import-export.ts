import { z } from "zod";
import { persistedSettingsBackupSchema } from "./settings";
import { customConfigSchema } from "./custom-config";
import {
  createApiSubscriptionSchema,
  logoReferenceSchema,
  subscriptionCreateBodySchema,
} from "./subscriptions";
import { apiSuccessResponseSchema } from "./api";
import { exchangeRateSnapshotV1Schema } from "./exchange-rates";
import { apiBillingRecordSchema } from "./billing-records";

/**
 * 单次导入执行的订阅上限。
 *
 * 预览允许大文件做冲突分析，但真正写库限制为较小批量，避免 Cloudflare D1/PocketBase 在一次请求里承担无界写入。
 */
export const IMPORT_APPLY_SUBSCRIPTION_LIMIT = 200;
export const IMPORT_PREVIEW_SUBSCRIPTION_LIMIT = 1000;
export const IMPORT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
/** 分组与续订流水只随 Renewo 自导出恢复；流水是不可变快照，条数上限高于订阅，但仍受 8 MiB body 约束。 */
export const IMPORT_GROUPS_LIMIT = 100;
export const IMPORT_BILLING_RECORDS_LIMIT = 2000;
/** 账号库凭据只随 Renewo 自导出恢复；上限与 Go maxVaultExportCredentials 对齐。 */
export const IMPORT_VAULT_CREDENTIALS_LIMIT = 200;

export const importConflictModeSchema = z.enum(["replace", "skip"]);
export type ImportConflictMode = z.infer<typeof importConflictModeSchema>;

export const importSourceSchema = z.enum(["renewlet", "wallos", "ai"]);
export type ImportSource = z.infer<typeof importSourceSchema>;

export const importConfidenceSchema = z.enum(["high", "low"]);
export type ImportConfidence = z.infer<typeof importConfidenceSchema>;

export const importKeySchema = z.object({
  source: importSourceSchema,
  sourceId: z.string().trim().min(1).max(256),
  confidence: importConfidenceSchema.optional(),
}).strict();

const importExtraSchema = z.object({
  // import 是跨 Docker/PocketBase 与 Cloudflare/D1 的幂等键；导入 API 依赖它判断 replace/skip。
  import: importKeySchema,
}).catchall(z.unknown());

export const importSubscriptionSchema = subscriptionCreateBodySchema.safeExtend({
  extra: importExtraSchema,
}).strict();
export type ImportSubscription = z.infer<typeof importSubscriptionSchema>;

/**
 * 导入分组形状。
 *
 * id 是导出实例内的源分组 ID：恢复时服务端先重建分组得到新 ID，再把订阅的 groupId 重映射到新 ID。
 * logo 在 apply 时必须已是受控资产路径（前端已上传 ZIP 内资产），与订阅 logo 同一边界。
 */
export const importGroupSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  logo: logoReferenceSchema.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().nonnegative(),
}).strict();
export type ImportGroup = z.infer<typeof importGroupSchema>;

/**
 * 导入续订流水沿用完整记录 wire shape；id/subscriptionId 都是导出实例内的源 ID：
 * 服务端按 (subscription, billingDate, mode) 幂等 upsert，不保留源记录 ID。
 */
export const importBillingRecordSchema = apiBillingRecordSchema;
export type ImportBillingRecord = z.infer<typeof importBillingRecordSchema>;

/**
 * 备份包 KDF envelope：目标实例凭 salt+params 复算 Argon2id KEK 解密凭据密文。
 * salt 由导出实例生成并随包携带，改备份密码会生成新 salt，旧备份包不受影响。
 */
export const importBackupEnvelopeSchema = z.object({
  kdf: z.literal("argon2id"),
  version: z.literal(1),
  salt: z.string().trim().min(16).max(128),
  params: z.object({
    memoryKiB: z.number().int().positive(),
    iterations: z.number().int().positive(),
    parallelism: z.number().int().positive(),
  }).strict(),
}).strict();
export type ImportBackupEnvelope = z.infer<typeof importBackupEnvelopeSchema>;

/**
 * 备份包内账号库凭据形状：passwordBackup/notesBackup 是备份密码 KEK 的 AES-GCM 密文
 * （v1.nonce.ct），明文密码永不进包。subscriptionId/groupId 是源实例 ID，
 * 恢复时按映射重绑，映射不到置空（凭据保留为独立账号）。
 */
export const importVaultCredentialSchema = z.object({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  url: z.string().trim().max(2048),
  username: z.string().trim().max(200),
  sortOrder: z.number().int().nonnegative(),
  subscriptionId: z.string().trim().max(64),
  groupId: z.string().trim().max(64),
  passwordBackup: z.string().max(4096),
  notesBackup: z.string().max(10240),
}).strict();
export type ImportVaultCredential = z.infer<typeof importVaultCredentialSchema>;

export const importPayloadSchema = z.object({
  source: importSourceSchema,
  // 导入 payload 是前端、Go route 与 Worker apply 共享契约；上限保护预览解析和冲突查询，不代表一次写库上限。
  subscriptions: z.array(importSubscriptionSchema).max(IMPORT_PREVIEW_SUBSCRIPTION_LIMIT, "IMPORT_TOO_LARGE"),
  settings: persistedSettingsBackupSchema.optional(),
  customConfig: customConfigSchema.optional(),
  exchangeRateSnapshots: z.array(exchangeRateSnapshotV1Schema).max(240).optional(),
  // 分组与流水只允许出现在 Renewo 自导出包；Wallos/AI 导入没有这些实体。
  groups: z.array(importGroupSchema).max(IMPORT_GROUPS_LIMIT, "IMPORT_TOO_MANY_GROUPS").optional(),
  billingRecords: z.array(importBillingRecordSchema).max(IMPORT_BILLING_RECORDS_LIMIT, "IMPORT_TOO_MANY_BILLING_RECORDS").optional(),
  // 账号库凭据段只随 Renewo 自导出/云快照出现；apply 必须携带 backupPassphrase 才能解密。
  backupEnvelope: importBackupEnvelopeSchema.optional(),
  vaultCredentials: z.array(importVaultCredentialSchema).max(IMPORT_VAULT_CREDENTIALS_LIMIT, "IMPORT_TOO_MANY_VAULT_CREDENTIALS").optional(),
}).strict();
export type ImportPayload = z.infer<typeof importPayloadSchema>;

export const importSkipIndexesSchema = z.array(z.number().int().nonnegative()).max(IMPORT_PREVIEW_SUBSCRIPTION_LIMIT, "IMPORT_TOO_LARGE");
export const importApplySkipIndexesSchema = z.array(z.number().int().nonnegative()).max(IMPORT_APPLY_SUBSCRIPTION_LIMIT);
// forceReplaceIndexes 允许逐条强制替换命中现有订阅的条目；语义上与 skipIndexes 互斥（同一条不能同时跳过和替换）。
// 只在 conflictMode="skip" 时生效——"替换已有记录"模式下全部 existing 已经是 replace，不需要覆盖。
export const importForceReplaceIndexesSchema = importApplySkipIndexesSchema;

export const importPreviewRequestSchema = z.object({
  payload: importPayloadSchema,
  conflictMode: importConflictModeSchema.default("skip"),
  // skipIndexes 是预览与执行共享的“单条排除”契约；服务端仍会按当前用户重新预览，不能信任前端 action。
  skipIndexes: importSkipIndexesSchema.default([]),
  // forceReplaceIndexes 让 skip 模式下的特定条目强制替换；执行端会做与 skipIndexes 的互斥校验。
  forceReplaceIndexes: importForceReplaceIndexesSchema.default([]),
  // 备份密码仅当包内含账号库凭据段时由前端随请求携带；preview 忽略，apply 必填。
  backupPassphrase: z.string().max(256).optional(),
}).strict();
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

export const importApplyRequestSchema = z.object({
  payload: importPayloadSchema.extend({
    // 执行阶段比预览更严格，因为 replace/create 会触发真实写库、资产引用和用户隔离校验。
    subscriptions: z.array(importSubscriptionSchema).max(IMPORT_APPLY_SUBSCRIPTION_LIMIT, "IMPORT_TOO_LARGE"),
  }),
  conflictMode: importConflictModeSchema,
  skipIndexes: importApplySkipIndexesSchema.default([]),
  forceReplaceIndexes: importForceReplaceIndexesSchema.default([]),
  // 包内含账号库凭据段时 apply 必填；服务端用 GCM 认证判定密码正确性。
  backupPassphrase: z.string().max(256).optional(),
}).strict();
export type ImportApplyRequest = z.infer<typeof importApplyRequestSchema>;

export const importItemActionSchema = z.enum(["create", "replace", "skip", "error"]);
export type ImportItemAction = z.infer<typeof importItemActionSchema>;

export const importPreviewItemSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  source: importSourceSchema,
  sourceId: z.string(),
  existingId: z.string().optional(),
  action: importItemActionSchema,
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
}).strict();
export type ImportPreviewItem = z.infer<typeof importPreviewItemSchema>;

export const importSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  creates: z.number().int().nonnegative(),
  replaces: z.number().int().nonnegative(),
  skips: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
}).strict();
export type ImportSummary = z.infer<typeof importSummarySchema>;

export const importPreviewPayloadSchema = z.object({
  summary: importSummarySchema,
  items: z.array(importPreviewItemSchema),
  includesSettings: z.boolean(),
  includesCustomConfig: z.boolean(),
  includesExchangeRateSnapshots: z.boolean(),
  exchangeRateSnapshotsCount: z.number().int().nonnegative(),
  includesGroups: z.boolean(),
  groupsCount: z.number().int().nonnegative(),
  includesBillingRecords: z.boolean(),
  billingRecordsCount: z.number().int().nonnegative(),
  includesVaultCredentials: z.boolean(),
  vaultCredentialsCount: z.number().int().nonnegative(),
}).strict();
export const importPreviewResponseSchema = apiSuccessResponseSchema(importPreviewPayloadSchema);
export type ImportPreviewResponse = z.infer<typeof importPreviewPayloadSchema>;

export const importApplyPayloadSchema = importPreviewPayloadSchema.extend({
  vaultCredentialsRestored: z.number().int().nonnegative(),
  vaultCredentialsSkipped: z.boolean(),
  vaultCredentialsSkipReason: z.enum(["empty", "invalid"]).optional(),
}).strict();
export const importApplyResponseSchema = apiSuccessResponseSchema(importApplyPayloadSchema);
export type ImportApplyResponse = z.infer<typeof importApplyPayloadSchema>;

const exportPrivateAssetPathSchema = z
  .string()
  .trim()
  .refine((value) => /^\/api\/app\/assets\/[A-Za-z0-9_-]+$/.test(value), "Invalid private asset path");

const exportAssetSchema = z.object({
  id: z.string(),
  path: z.string(),
  originalName: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
}).strict();
export type RenewletExportAsset = z.infer<typeof exportAssetSchema>;

const exportAssetLogoPathSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => /^assets\/[^/][A-Za-z0-9._/-]*$/.test(value) && !value.includes(".."), "Invalid export asset path");

const renewletExportSubscriptionSchema = createApiSubscriptionSchema(
  logoReferenceSchema.or(exportAssetLogoPathSchema),
);

/**
 * 备份中的分组形状：logo 可能是外链、受控资产路径或 ZIP 内 assets/ 路径。
 * id 是源实例分组 ID，恢复时用于把订阅/group 关联重映射到新实例。
 */
export const renewletExportGroupSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
  logo: logoReferenceSchema.or(exportAssetLogoPathSchema).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().nonnegative(),
}).strict();
export type RenewletExportGroup = z.infer<typeof renewletExportGroupSchema>;

export const renewletExportV1Schema = z.object({
  kind: z.literal("renewlet-export"),
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  data: z.object({
    // Export v1 保存 API 订阅形状而不是 UI 草稿形状，保证 Docker 与 Cloudflare 导出的数据可以互导。
    subscriptions: z.array(renewletExportSubscriptionSchema),
    settings: persistedSettingsBackupSchema.optional(),
    customConfig: customConfigSchema.optional(),
    // 历史汇率快照是 data.json 的恢复事实源；manifest 只做审计，不能承载报表口径。
    exchangeRateSnapshots: z.array(exchangeRateSnapshotV1Schema).max(240).optional(),
    // 分组与续订流水是 Renewo 业务实体；旧备份缺失时按 optional 降级，不影响订阅恢复。
    groups: z.array(renewletExportGroupSchema).max(IMPORT_GROUPS_LIMIT).optional(),
    billingRecords: z.array(apiBillingRecordSchema).max(IMPORT_BILLING_RECORDS_LIMIT).optional(),
    // 账号库凭据段：已设置备份密码的实例自动云快照/手动导出才会包含；旧包缺失时按 optional 降级。
    backupEnvelope: importBackupEnvelopeSchema.optional(),
    vaultCredentials: z.array(importVaultCredentialSchema).max(IMPORT_VAULT_CREDENTIALS_LIMIT).optional(),
    assets: z.array(exportAssetSchema).optional(),
  }).strict(),
}).strict();
export type RenewletExportV1 = z.infer<typeof renewletExportV1Schema>;

export const renewletExportMissingAssetReferenceSchema = z.enum([
  "subscription.logo",
  "customConfig.paymentMethods.icon",
  "group.logo",
  "billingRecord.receiptAssetIds",
]);
export type RenewletExportMissingAssetReference = z.infer<typeof renewletExportMissingAssetReferenceSchema>;

export const renewletExportMissingAssetReasonSchema = z.enum(["not_found", "file_missing", "too_large", "read_failed"]);
export type RenewletExportMissingAssetReason = z.infer<typeof renewletExportMissingAssetReasonSchema>;

export const renewletExportMissingAssetSchema = z.object({
  assetId: z.string().trim().min(1),
  path: exportPrivateAssetPathSchema,
  reference: renewletExportMissingAssetReferenceSchema,
  referenceId: z.string().trim().min(1),
  reason: renewletExportMissingAssetReasonSchema,
}).strict();
export type RenewletExportMissingAsset = z.infer<typeof renewletExportMissingAssetSchema>;

export const renewletExportManifestV1Schema = z.object({
  kind: z.literal("renewlet-export"),
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  subscriptions: z.number().int().nonnegative(),
  groups: z.number().int().nonnegative(),
  billingRecords: z.number().int().nonnegative(),
  assets: z.number().int().nonnegative(),
  // manifest 只做 ZIP 审计；导入恢复仍以 data.json 为事实源，缺失资产不能反向驱动写库。
  missingAssets: z.array(renewletExportMissingAssetSchema),
}).strict();
export type RenewletExportManifestV1 = z.infer<typeof renewletExportManifestV1Schema>;
