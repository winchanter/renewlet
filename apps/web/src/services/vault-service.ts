import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { apiFetch } from "@/lib/api-client";
import { getCurrentUserId } from "@/lib/pocketbase";
import {
  vaultCredentialDeleteResponseSchema,
  vaultCredentialResponseSchema,
  vaultCredentialRevealResponseSchema,
  vaultCredentialsListResponseSchema,
  type VaultCredential,
  type VaultCredentialCreateRequest,
  type VaultCredentialUpdateRequest,
} from "@renewlet/shared/schemas/vault";

/**
 * 账号库服务。
 *
 * 明文密码只经 reveal 动作返回且即时消费（复制/展示），不落任何缓存或组件状态持久层。
 */

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
