import { z } from "zod";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";

/**
 * 账号库（Credential Vault）共享契约。
 *
 * 只服务 Go/Docker 运行面；Cloudflare Worker 暂不实现。
 * 结构分 4 个域：凭据 CRUD/reveal；一次性授权码；访问申请；审计日志。
 */

// ============== 凭据（P1） ==============

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

/** 更新请求：null 清空，缺省保持不变，密码不 trim。 */
export const vaultCredentialUpdateRequestSchema = z.object({
  subscriptionId: z.string().trim().max(128).nullable().optional(),
  title: z.string().trim().min(1).max(120).nullable().optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  username: z.string().trim().max(200).nullable().optional(),
  password: z.string().max(1024).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
}).strict();

export type VaultCredentialUpdateRequest = z.infer<typeof vaultCredentialUpdateRequestSchema>;

// ============== P2-A：一次性访问授权码 ==============

export const vaultAccessCodeStatusSchema = z.enum(["active", "used", "revoked", "expired"]);
export type VaultAccessCodeStatus = z.infer<typeof vaultAccessCodeStatusSchema>;

export const vaultAccessCodeSchema = z.object({
  id: z.string().trim().min(1),
  // 允许空：P2 初版（按订阅绑定）生成的历史码没有 credential 绑定，列表需能渲染它们（服务端会将其状态推导为 revoked）
  credentialId: z.string().trim().max(128),
  credentialTitle: z.string().trim().max(120),
  subscriptionId: z.string().max(128), // 冗余，可能为空（独立账号）
  codeMask: z.string().max(16),
  note: z.string().max(500),
  expiresAt: z.string().min(1),
  maxAttempts: z.number().int().min(1),
  attempts: z.number().int().nonnegative(),
  status: vaultAccessCodeStatusSchema,
  usedAt: z.string(),
  revokedAt: z.string(),
  requestId: z.string(),
  createdAt: z.string(),
  // 明文是否加密存档（可重复查阅）；旧版 hash-only 码为 false。
  hasPlainCode: z.boolean(),
}).strict();
export type VaultAccessCode = z.infer<typeof vaultAccessCodeSchema>;

export const vaultAccessCodesListPayloadSchema = z.object({
  codes: z.array(vaultAccessCodeSchema),
}).strict();
export const vaultAccessCodesListResponseSchema = apiSuccessResponseSchema(vaultAccessCodesListPayloadSchema);

/** 创建授权码：绑定具体账号（credentialId）。独立账号允许不关联订阅，因此不再校验 subscriptionId 非空。 */
export const vaultAccessCodeCreateRequestSchema = z.object({
  credentialId: z.string().trim().min(1).max(128),
  note: z.string().trim().max(500).optional(),
  expireHours: z.number().int().min(1).max(168).optional(), // 1h ~ 7d
  maxAttempts: z.number().int().min(1).max(100).optional(),
}).strict();
export type VaultAccessCodeCreateRequest = z.infer<typeof vaultAccessCodeCreateRequestSchema>;

/** 创建响应只暴露一次 plainCode，后续只存 hash。 */
export const vaultAccessCodeCreatedSchema = vaultAccessCodeSchema.extend({
  plainCode: z.string().trim().min(1).max(32),
}).strict();
export const vaultAccessCodeCreatedResponseSchema = apiSuccessResponseSchema(vaultAccessCodeCreatedSchema);
export type VaultAccessCodeCreated = z.infer<typeof vaultAccessCodeCreatedSchema>;

export const vaultAccessCodeRevokeResponseSchema = okResponseSchema;

/** 明文重复查阅：明文已加密存档（hasPlainCode=true）的码可通过 reveal 端点再次获取。 */
export const vaultAccessCodePlainRevealPayloadSchema = z.object({
  plainCode: z.string().trim().min(1).max(32),
}).strict();
export const vaultAccessCodePlainRevealResponseSchema = apiSuccessResponseSchema(vaultAccessCodePlainRevealPayloadSchema);
export type VaultAccessCodePlainReveal = z.infer<typeof vaultAccessCodePlainRevealPayloadSchema>;

/** 兑换授权码：码本身已绑定 credentialId，无需再传。 */
export const vaultAccessCodeRedeemRequestSchema = z.object({
  code: z.string().trim().min(1).max(32),
}).strict();
export type VaultAccessCodeRedeemRequest = z.infer<typeof vaultAccessCodeRedeemRequestSchema>;

export const vaultAccessCodeRedeemPayloadSchema = z.object({
  password: z.string().max(1024),
  credentialId: z.string().min(1),
  subscriptionId: z.string().max(128), // 冗余，独立账号可能为空
  title: z.string().max(120),
  url: z.string().max(2048),
  username: z.string().max(200),
  notes: z.string().max(5000),
}).strict();
export const vaultAccessCodeRedeemResponseSchema = apiSuccessResponseSchema(vaultAccessCodeRedeemPayloadSchema);
export type VaultAccessCodeRedeemPayload = z.infer<typeof vaultAccessCodeRedeemPayloadSchema>;

// ============== P2-B：访问申请与审批 ==============

export const vaultAccessRequestStatusSchema = z.enum(["pending", "approved", "declined", "expired", "closed"]);
export type VaultAccessRequestStatus = z.infer<typeof vaultAccessRequestStatusSchema>;

export const vaultAccessRequestSchema = z.object({
  id: z.string().trim().min(1),
  subscriptionId: z.string().trim().min(1).max(128),
  publicStatusPageId: z.string().trim().min(1).max(128),
  note: z.string().max(500),
  status: vaultAccessRequestStatusSchema,
  decidedAt: z.string(),
  createdAt: z.string(),
  codeId: z.string(),
}).strict();
export type VaultAccessRequest = z.infer<typeof vaultAccessRequestSchema>;

export const vaultAccessRequestsListPayloadSchema = z.object({
  requests: z.array(vaultAccessRequestSchema),
}).strict();
export const vaultAccessRequestsListResponseSchema = apiSuccessResponseSchema(vaultAccessRequestsListPayloadSchema);
export type VaultAccessRequestsListPayload = z.infer<typeof vaultAccessRequestsListPayloadSchema>;

/** 公开页面发起访问申请。 */
export const vaultAccessRequestCreatePublicBodySchema = z.object({
  subscriptionId: z.string().trim().min(1).max(128),
  note: z.string().trim().max(500).optional(),
}).strict();
export type VaultAccessRequestCreatePublicBody = z.infer<typeof vaultAccessRequestCreatePublicBodySchema>;

export const vaultAccessRequestCreatedSchema = z.object({
  id: z.string().min(1),
  status: z.literal("pending"),
}).strict();
export const vaultAccessRequestCreatedResponseSchema = apiSuccessResponseSchema(vaultAccessRequestCreatedSchema);

export const vaultAccessRequestDecideActionSchema = z.enum(["approve", "decline", "close"]);
export type VaultAccessRequestDecideAction = z.infer<typeof vaultAccessRequestDecideActionSchema>;

/**
 * 审批决定请求：
 * - approve：必须传 credentialId（指定授权给哪个具体账号），并可写 expireHours/maxAttempts/note
 * - decline/close：只传 note 即可
 */
export const vaultAccessRequestDecideRequestSchema = z.object({
  action: vaultAccessRequestDecideActionSchema,
  credentialId: z.string().trim().min(1).max(128).optional(),
  note: z.string().trim().max(500).optional(),
  expireHours: z.number().int().min(1).max(168).optional(),
  maxAttempts: z.number().int().min(1).max(100).optional(),
}).strict();
export type VaultAccessRequestDecideRequest = z.infer<typeof vaultAccessRequestDecideRequestSchema>;

/** approve：返回新生成的授权码明文 + 元数据；decline/close：只返回状态。 */
const vaultAccessRequestDecidedBaseSchema = z.object({
  id: z.string().min(1),
  status: vaultAccessRequestStatusSchema,
}).strict();
export const vaultAccessRequestDecidedResponseSchema = apiSuccessResponseSchema(
  vaultAccessRequestDecidedBaseSchema.and(
    z.object({
      codeId: z.string().optional(),
      plainCode: z.string().optional(),
      codeMask: z.string().optional(),
      expiresAt: z.string().optional(),
    }).strict(),
  ),
);

// ============== P2-C：审计日志 ==============

export const vaultLogActionSchema = z.enum([
  "credential_viewed",
  "credential_created",
  "credential_updated",
  "credential_deleted",
  "code_generated",
  "code_redeemed",
  "code_revoked",
  "code_viewed",
  "request_submitted",
  "request_approved",
  "request_declined",
  "request_closed",
]);
export type VaultLogAction = z.infer<typeof vaultLogActionSchema>;

export const vaultAccessLogSchema = z.object({
  id: z.string().trim().min(1),
  action: z.string().min(1).max(40),
  source: z.enum(["admin", "public"]),
  result: z.enum(["success", "failure"]),
  subscriptionId: z.string(),
  credentialId: z.string(),
  codeId: z.string(),
  ip: z.string().max(64),
  userAgent: z.string().max(300),
  detail: z.record(z.string(), z.any()).nullable(),
  createdAt: z.string(),
}).strict();
export type VaultAccessLog = z.infer<typeof vaultAccessLogSchema>;

export const vaultAccessLogsPayloadSchema = z.object({
  logs: z.array(vaultAccessLogSchema),
  nextTime: z.string(),
  nextId: z.string(),
  hasMore: z.boolean(),
}).strict();
export const vaultAccessLogsResponseSchema = apiSuccessResponseSchema(vaultAccessLogsPayloadSchema);
export type VaultAccessLogsPayload = z.infer<typeof vaultAccessLogsPayloadSchema>;

export const vaultLogsFilterActionSchema = z.union([vaultLogActionSchema, z.literal("all")]);
export type VaultLogsFilterAction = z.infer<typeof vaultLogsFilterActionSchema>;
