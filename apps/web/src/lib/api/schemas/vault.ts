// 账号库契约只服务 Go/Docker 运行面；re-export 保证前端与 Go 端 schema 不漂移。
export * from "@renewlet/shared/schemas/vault";

import { z } from "zod";
import { apiSuccessResponseSchema } from "@renewlet/shared/schemas/api";
import { importBackupEnvelopeSchema, importVaultCredentialSchema } from "@renewlet/shared/schemas/import-export";

// ============== 备份密码（Vault Backup Keys） ==============
// backup-keys 与 vault/export 是 Go Docker 面专属路由；响应形状与 Go handler 对齐，
// 待 shared 收纳契约后再迁移 re-export，前端只消费这里的 schema 边界。

export const vaultBackupKeysStatusPayloadSchema = z.object({
  configured: z.boolean(),
});
export const vaultBackupKeysStatusResponseSchema = apiSuccessResponseSchema(vaultBackupKeysStatusPayloadSchema);
export type VaultBackupKeysStatusPayload = z.infer<typeof vaultBackupKeysStatusPayloadSchema>;

export const vaultBackupExportPayloadSchema = z.object({
  backupEnvelope: importBackupEnvelopeSchema,
  vaultCredentials: z.array(importVaultCredentialSchema),
});
export const vaultBackupExportResponseSchema = apiSuccessResponseSchema(vaultBackupExportPayloadSchema);
export type VaultBackupExportPayload = z.infer<typeof vaultBackupExportPayloadSchema>;

export const vaultImportVerifyPayloadSchema = z.object({
  valid: z.boolean(),
});
export const vaultImportVerifyResponseSchema = apiSuccessResponseSchema(vaultImportVerifyPayloadSchema);
export type VaultImportVerifyPayload = z.infer<typeof vaultImportVerifyPayloadSchema>;
