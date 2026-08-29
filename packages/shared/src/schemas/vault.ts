import { z } from "zod";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";

/**
 * 账号库（Credential Vault）共享契约。
 *
 * Go 端只输出凭据的非敏感字段与 hasPassword 标记；明文密码仅经 reveal 动作返回。
 * 这里只服务 Go/Docker 运行面；Cloudflare Worker 运行面暂不实现 vault 模块。
 */

export const vaultCredentialSchema = z.object({
  id: z.string().trim().min(1),
  subscriptionId: z.string(),
  title: z.string().trim().min(1).max(120),
  url: z.string().max(2048),
  username: z.string().max(200),
  notes: z.string().max(5000),
  hasPassword: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export type VaultCredential = z.infer<typeof vaultCredentialSchema>;

export const vaultCredentialsListPayloadSchema = z.object({
  credentials: z.array(vaultCredentialSchema),
}).strict();
export const vaultCredentialsListResponseSchema = apiSuccessResponseSchema(vaultCredentialsListPayloadSchema);

export const vaultCredentialResponseSchema = apiSuccessResponseSchema(vaultCredentialSchema);

export const vaultCredentialDeleteResponseSchema = okResponseSchema;

export type VaultCredentialsListPayload = z.infer<typeof vaultCredentialsListPayloadSchema>;

export const vaultCredentialRevealPayloadSchema = z.object({
  password: z.string().max(1024),
}).strict();
export const vaultCredentialRevealResponseSchema = apiSuccessResponseSchema(vaultCredentialRevealPayloadSchema);

export type VaultCredentialRevealPayload = z.infer<typeof vaultCredentialRevealPayloadSchema>;

/** 创建请求：缺省字段落空值；password 只在创建时允许非空明文。 */
export const vaultCredentialCreateRequestSchema = z.object({
  subscriptionId: z.string().trim().max(128).optional(),
  title: z.string().trim().min(1).max(120),
  url: z.string().trim().max(2048).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(1024).optional(),
  notes: z.string().max(5000).optional(),
}).strict();

export type VaultCredentialCreateRequest = z.infer<typeof vaultCredentialCreateRequestSchema>;

/** 更新请求：区分缺省（保持不变）、显式 null（清除）与空串；password null 表示清除已存密码。 */
export const vaultCredentialUpdateRequestSchema = z.object({
  subscriptionId: z.string().trim().max(128).nullable().optional(),
  title: z.string().trim().min(1).max(120).nullable().optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  username: z.string().trim().max(200).nullable().optional(),
  password: z.string().max(1024).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
}).strict();

export type VaultCredentialUpdateRequest = z.infer<typeof vaultCredentialUpdateRequestSchema>;
