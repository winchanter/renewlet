import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { apiFetch } from "@/lib/api-client";
import { getCurrentUserId } from "@/lib/pocketbase";
import {
  vaultAccessCodeCreatedResponseSchema,
  vaultAccessCodePlainRevealResponseSchema,
  vaultAccessCodeRedeemResponseSchema,
  vaultAccessCodesListResponseSchema,
  vaultAccessLogsResponseSchema,
  vaultAccessRequestDecidedResponseSchema,
  vaultAccessRequestsListResponseSchema,
  vaultCredentialDeleteResponseSchema,
  vaultCredentialResponseSchema,
  vaultCredentialRevealResponseSchema,
  vaultCredentialsListResponseSchema,
  type VaultAccessCode,
  type VaultAccessCodeCreated,
  type VaultAccessCodeRedeemPayload,
  type VaultAccessLog,
  type VaultAccessLogsPayload,
  type VaultAccessRequest,
  type VaultCredential,
} from "@renewlet/shared/schemas/vault";
import type {
  VaultAccessCodeCreateRequest,
  VaultAccessCodeRedeemRequest,
  VaultAccessRequestDecideRequest,
  VaultCredentialCreateRequest,
  VaultCredentialUpdateRequest,
} from "@renewlet/shared/schemas/vault";

export type {
  VaultAccessCodeCreateRequest,
  VaultAccessCodeRedeemRequest,
  VaultAccessRequestDecideRequest,
  VaultCredentialCreateRequest,
  VaultCredentialUpdateRequest,
};

/**
 * 账号库服务。
 *
 * 明文密码只经 reveal / redeem 动作返回且即时消费（复制/展示），不落任何缓存或组件状态持久层。
 * P2-A/B/C：一次性授权码、访问申请与审批、审计日志。
 */

// ============== 凭据（P1） ==============

export interface ListVaultCredentialsOptions {
  subscriptionId?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** 拉取当前用户凭据列表；传 subscriptionId 时只返回该订阅的关联账号。 */
export async function listVaultCredentials(options: ListVaultCredentialsOptions = {}): Promise<VaultCredential[]> {
  if (!getCurrentUserId()) return [];
  const params = new URLSearchParams();
  if (options.subscriptionId) params.set("subscriptionId", options.subscriptionId);
  const query = params.toString();
  const data = await apiFetch(
    `/api/app/vault/credentials${query ? `?${query}` : ""}`,
    vaultCredentialsListResponseSchema,
    options.signal ? { signal: options.signal } : undefined,
  );
  return data.credentials;
}

export async function createVaultCredential(
  body: VaultCredentialCreateRequest,
  signal?: AbortSignal,
): Promise<VaultCredential> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch("/api/app/vault/credentials", vaultCredentialResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal ? { signal } : undefined),
  });
  return data;
}

/** 更新凭据；patch 语义遵循共享契约——缺省保持不变，显式 null 清除。 */
export async function updateVaultCredential(
  credentialId: string,
  patch: VaultCredentialUpdateRequest,
  signal?: AbortSignal,
): Promise<VaultCredential> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch(`/api/app/vault/credentials/${encodeURIComponent(credentialId)}`, vaultCredentialResponseSchema, {
    method: "PATCH",
    body: JSON.stringify(patch),
    ...(signal ? { signal } : undefined),
  });
  return data;
}

export async function deleteVaultCredential(credentialId: string, signal?: AbortSignal): Promise<void> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  await apiFetch(`/api/app/vault/credentials/${encodeURIComponent(credentialId)}`, vaultCredentialDeleteResponseSchema, {
    method: "DELETE",
    ...(signal ? { signal } : undefined),
  });
}

/** 揭示明文密码；服务端会写入审计日志，调用方应即时消费返回值。 */
export async function revealVaultCredentialPassword(credentialId: string, signal?: AbortSignal): Promise<string> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch(
    `/api/app/vault/credentials/${encodeURIComponent(credentialId)}/reveal`,
    vaultCredentialRevealResponseSchema,
    { method: "POST", ...(signal ? { signal } : undefined) },
  );
  return data.password;
}

// ============== P2-A：一次性授权码 ==============

export interface ListVaultAccessCodesOptions {
  credentialId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export async function listVaultAccessCodes(options: ListVaultAccessCodesOptions = {}): Promise<VaultAccessCode[]> {
  if (!getCurrentUserId()) return [];
  const params = new URLSearchParams();
  if (options.credentialId) params.set("credentialId", options.credentialId);
  const query = params.toString();
  const data = await apiFetch(
    `/api/app/vault/access-codes${query ? `?${query}` : ""}`,
    vaultAccessCodesListResponseSchema,
    options.signal ? { signal: options.signal } : undefined,
  );
  return data.codes;
}

export async function createVaultAccessCode(
  body: VaultAccessCodeCreateRequest,
  signal?: AbortSignal,
): Promise<VaultAccessCodeCreated> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  return await apiFetch("/api/app/vault/access-codes", vaultAccessCodeCreatedResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal ? { signal } : undefined),
  });
}

export async function revokeVaultAccessCode(codeId: string, signal?: AbortSignal): Promise<void> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  await apiFetch(`/api/app/vault/access-codes/${encodeURIComponent(codeId)}/revoke`, vaultCredentialDeleteResponseSchema, {
    method: "POST",
    ...(signal ? { signal } : undefined),
  });
}

/** 重复查阅授权码明文（明文已加密存档的码可用）；服务端会写入审计日志，调用方应即时消费返回值。 */
export async function revealVaultAccessCodePlain(codeId: string, signal?: AbortSignal): Promise<string> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch(
    `/api/app/vault/access-codes/${encodeURIComponent(codeId)}/reveal`,
    vaultAccessCodePlainRevealResponseSchema,
    { method: "POST", ...(signal ? { signal } : undefined) },
  );
  return data.plainCode;
}

/** 用授权码兑换明文凭据；一次性消耗。 */
export async function redeemVaultAccessCode(
  body: VaultAccessCodeRedeemRequest,
  signal?: AbortSignal,
): Promise<VaultAccessCodeRedeemPayload> {
  const data = await apiFetch("/api/app/vault/access-codes/redeem", vaultAccessCodeRedeemResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal ? { signal } : undefined),
  });
  return data;
}

// ============== P2-B：访问申请 ==============

export interface ListVaultAccessRequestsOptions {
  status?: "pending" | "approved" | "declined" | "expired" | "closed" | "all";
  subscriptionId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export async function listVaultAccessRequests(options: ListVaultAccessRequestsOptions = {}): Promise<VaultAccessRequest[]> {
  if (!getCurrentUserId()) return [];
  const params = new URLSearchParams();
  if (options.status && options.status !== "all") params.set("status", options.status);
  if (options.subscriptionId) params.set("subscriptionId", options.subscriptionId);
  const query = params.toString();
  const data = await apiFetch(
    `/api/app/vault/access-requests${query ? `?${query}` : ""}`,
    vaultAccessRequestsListResponseSchema,
    options.signal ? { signal: options.signal } : undefined,
  );
  return data.requests;
}

export interface VaultAccessRequestDecideResult {
  id: string;
  status: string;
  codeId?: string;
  plainCode?: string;
  codeMask?: string;
  expiresAt?: string;
}

export async function decideVaultAccessRequest(
  requestId: string,
  body: VaultAccessRequestDecideRequest,
  signal?: AbortSignal,
): Promise<VaultAccessRequestDecideResult> {
  if (!getCurrentUserId()) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
  const data = await apiFetch(
    `/api/app/vault/access-requests/${encodeURIComponent(requestId)}/decide`,
    vaultAccessRequestDecidedResponseSchema,
    {
      method: "POST",
      body: JSON.stringify(body),
      ...(signal ? { signal } : undefined),
    },
  );
  const parsed = data as {
    id: string;
    status: string;
    codeId?: string;
    plainCode?: string;
    codeMask?: string;
    expiresAt?: string;
  };
  const out: VaultAccessRequestDecideResult = {
    id: parsed.id,
    status: parsed.status,
  };
  if (parsed.codeId) out.codeId = parsed.codeId;
  if (parsed.plainCode) out.plainCode = parsed.plainCode;
  if (parsed.codeMask) out.codeMask = parsed.codeMask;
  if (parsed.expiresAt) out.expiresAt = parsed.expiresAt;
  return out;
}

// ============== P2-C：审计日志 ==============

export interface ListVaultAccessLogsOptions {
  action?: string | undefined;
  credentialId?: string | undefined;
  subscriptionId?: string | undefined;
  limit?: number | undefined;
  nextTime?: string | undefined;
  nextId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export async function listVaultAccessLogs(options: ListVaultAccessLogsOptions = {}): Promise<VaultAccessLogsPayload> {
  if (!getCurrentUserId()) {
    return { logs: [], nextTime: "", nextId: "", hasMore: false };
  }
  const params = new URLSearchParams();
  if (options.action && options.action !== "all") params.set("action", options.action);
  if (options.credentialId) params.set("credentialId", options.credentialId);
  if (options.subscriptionId) params.set("subscriptionId", options.subscriptionId);
  if (typeof options.limit === "number") params.set("limit", String(options.limit));
  if (options.nextTime) params.set("nextTime", options.nextTime);
  if (options.nextId) params.set("nextId", options.nextId);
  const data = await apiFetch(
    `/api/app/vault/access-logs?${params.toString()}`,
    vaultAccessLogsResponseSchema,
    options.signal ? { signal: options.signal } : undefined,
  );
  return {
    logs: data.logs as VaultAccessLog[],
    nextTime: data.nextTime ?? "",
    nextId: data.nextId ?? "",
    hasMore: !!data.hasMore,
  };
}
