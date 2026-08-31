import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  createVaultCredential,
  deleteVaultCredential,
  listVaultCredentials,
  revealVaultCredentialPassword,
  updateVaultCredential,
} from "@/services/vault-service";
import type { VaultCredentialCreateRequest, VaultCredentialUpdateRequest } from "@renewlet/shared/schemas/vault";

const VAULT_STALE_TIME_MS = 60_000;

export const vaultQueryKeys = {
  all: ["vault"] as const,
  list: (subscriptionId?: string | null, groupId?: string | null) => {
    if (subscriptionId) return ["vault", "list", "sub", subscriptionId] as const;
    if (groupId) return ["vault", "list", "group", groupId] as const;
    return ["vault", "list"] as const;
  },
};

export function invalidateVaultLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: vaultQueryKeys.all });
}

export interface UseVaultCredentialsOptions {
  /** 只看某个订阅的关联账号；null/undefined 表示不按订阅过滤。 */
  subscriptionId?: string | null | undefined;
  /** 只看某个组的共享账号；null/undefined 表示不按组过滤。与 subscriptionId 互斥。 */
  groupId?: string | null | undefined;
  enabled?: boolean | undefined;
}

/** 账号库列表；订阅详情弹窗与独立账号库页共用同一缓存族，变更后统一失效。 */
export function useVaultCredentials(options: UseVaultCredentialsOptions = {}) {
  const { subscriptionId = null, groupId = null, enabled = true } = options;
  return useQuery({
    queryKey: vaultQueryKeys.list(subscriptionId, groupId),
    queryFn: ({ signal }) =>
      listVaultCredentials({
        subscriptionId: subscriptionId ?? undefined,
        groupId: groupId ?? undefined,
        signal,
      }),
    staleTime: VAULT_STALE_TIME_MS,
    enabled,
  });
}

export function useCreateVaultCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: VaultCredentialCreateRequest) => createVaultCredential(body),
    onSuccess: () => invalidateVaultLists(queryClient),
  });
}

export function useUpdateVaultCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ credentialId, patch }: { credentialId: string; patch: VaultCredentialUpdateRequest }) =>
      updateVaultCredential(credentialId, patch),
    onSuccess: () => invalidateVaultLists(queryClient),
  });
}

export function useDeleteVaultCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentialId: string) => deleteVaultCredential(credentialId),
    onSuccess: () => invalidateVaultLists(queryClient),
  });
}

/**
 * 揭示密码；revealed 结果只交由调用方即时展示/复制，不写入任何缓存。
 * 服务端按次审计，这里不做客户端节流。
 */
export function useRevealVaultCredentialPassword() {
  return useMutation({
    mutationFn: ({ credentialId, signal }: { credentialId: string; signal?: AbortSignal }) =>
      revealVaultCredentialPassword(credentialId, signal),
  });
}
