import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createVaultAccessCode,
  decideVaultAccessRequest,
  listVaultAccessCodes,
  listVaultAccessLogs,
  listVaultAccessRequests,
  redeemVaultAccessCode,
  revealVaultAccessCodePlain,
  revokeVaultAccessCode,
  type ListVaultAccessCodesOptions,
  type ListVaultAccessLogsOptions,
  type ListVaultAccessRequestsOptions,
  type VaultAccessCodeCreateRequest,
  type VaultAccessCodeRedeemRequest,
  type VaultAccessRequestDecideRequest,
} from "@/services/vault-service";

/**
 * 账号库 P2 hooks：授权码、访问申请、审计日志。
 * 与 use-vault.ts 分开避免单文件膨胀；QueryKey 前缀与凭据域保持一致。
 */

const VAULT_QUERY_KEY = ["vault"];
const CODES_QUERY_KEY = [...VAULT_QUERY_KEY, "accessCodes"];
const REQUESTS_QUERY_KEY = [...VAULT_QUERY_KEY, "accessRequests"];
const LOGS_QUERY_KEY = [...VAULT_QUERY_KEY, "accessLogs"];

export function useVaultAccessCodes(options: ListVaultAccessCodesOptions = {}) {
  return useQuery({
    queryKey: [...CODES_QUERY_KEY, options.credentialId ?? "all"],
    queryFn: async ({ signal }) => await listVaultAccessCodes({ ...options, signal }),
  });
}

export function useCreateVaultAccessCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: VaultAccessCodeCreateRequest) => await createVaultAccessCode(body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CODES_QUERY_KEY });
    },
  });
}

export function useRevokeVaultAccessCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (codeId: string) => await revokeVaultAccessCode(codeId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: CODES_QUERY_KEY });
      await client.invalidateQueries({ queryKey: LOGS_QUERY_KEY });
    },
  });
}

export function useRedeemVaultAccessCode() {
  return useMutation({
    mutationFn: async (body: VaultAccessCodeRedeemRequest) => await redeemVaultAccessCode(body),
  });
}

/** 查阅授权码明文；服务端落审计日志。 */
export function useRevealVaultAccessCodePlain() {
  return useMutation({
    mutationFn: async (codeId: string) => await revealVaultAccessCodePlain(codeId),
    // 只读动作不改变码/日志数据，无需 invalidate；审计由服务端写入。
  });
}

export function useVaultAccessRequests(options: ListVaultAccessRequestsOptions = {}) {
  return useQuery({
    queryKey: [...REQUESTS_QUERY_KEY, options.status ?? "all", options.subscriptionId ?? "all"],
    queryFn: async ({ signal }) => await listVaultAccessRequests({ ...options, signal }),
  });
}

export function useDecideVaultAccessRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ requestId, body }: { requestId: string; body: VaultAccessRequestDecideRequest }) =>
      await decideVaultAccessRequest(requestId, body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: REQUESTS_QUERY_KEY });
      await client.invalidateQueries({ queryKey: CODES_QUERY_KEY });
      await client.invalidateQueries({ queryKey: LOGS_QUERY_KEY });
    },
  });
}

/**
 * 审计日志分页 hook。
 *
 * keyset 分页：options 里 (limit, action, credentialId, subscriptionId) 固定，
 * 调用方通过 appendNextPage / resetPages 管理翻页。
 */
export function useVaultAccessLogs(options: Omit<ListVaultAccessLogsOptions, "nextTime" | "nextId" | "signal"> = {}) {
  return useQuery({
    queryKey: [
      ...LOGS_QUERY_KEY,
      options.action ?? "all",
      options.credentialId ?? "all",
      options.subscriptionId ?? "all",
      options.limit ?? 50,
    ],
    queryFn: async ({ signal }) => {
      return await listVaultAccessLogs({ ...options, signal });
    },
  });
}

export function appendVaultLogsPages(
  current: Awaited<ReturnType<typeof listVaultAccessLogs>>,
  nextPage: Awaited<ReturnType<typeof listVaultAccessLogs>>,
) {
  return {
    logs: [...current.logs, ...nextPage.logs],
    nextTime: nextPage.nextTime,
    nextId: nextPage.nextId,
    hasMore: nextPage.hasMore,
  };
}
