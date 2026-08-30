import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Activity, AlertCircle, CheckCircle2, Eye, Globe2, Shield, XCircle } from "lucide-react";
import { useVaultAccessLogs } from "@/hooks/use-vault-p2";
import type { VaultAccessLog, VaultLogAction } from "@/types/subscription";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import { toast } from "@/components/ui/sonner";
import { getDisplayErrorMessage } from "@/lib/display-error";

const ACTION_LABEL_KEY: Partial<Record<VaultLogAction, MessageKey>> = {
  credential_viewed: "vault.logs.action.credential_viewed",
  credential_created: "vault.logs.action.credential_created",
  credential_updated: "vault.logs.action.credential_updated",
  credential_deleted: "vault.logs.action.credential_deleted",
  code_generated: "vault.logs.action.code_generated",
  code_redeemed: "vault.logs.action.code_redeemed",
  code_revoked: "vault.logs.action.code_revoked",
  code_viewed: "vault.logs.action.code_viewed",
  request_submitted: "vault.logs.action.request_submitted",
  request_approved: "vault.logs.action.request_approved",
  request_declined: "vault.logs.action.request_declined",
  request_closed: "vault.logs.action.request_closed",
};

type FilterAction = "all" | VaultLogAction;

const LOG_ACTION_ORDER: VaultLogAction[] = [
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
];

const PAGE_SIZE = 50;

export function AccessLogsSection() {
  const { t, formatDateTime } = useI18n();
  const [action, setAction] = useState<FilterAction>("all");

  const query = useVaultAccessLogs({
    action: action === "all" ? undefined : action,
    limit: PAGE_SIZE,
  });

  const logs = query.data?.logs ?? [];
  const hasMore = !!query.data?.hasMore;
  const nextTime = query.data?.nextTime ?? "";
  const nextId = query.data?.nextId ?? "";

  const [pagedLogs, setPagedLogs] = useState<VaultAccessLog[]>([]);
  const [currentHasMore, setCurrentHasMore] = useState(false);
  const [currentNextTime, setCurrentNextTime] = useState("");
  const [currentNextId, setCurrentNextId] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!query.isFetching) {
      setPagedLogs(logs);
      setCurrentHasMore(hasMore);
      setCurrentNextTime(nextTime);
      setCurrentNextId(nextId);
    }
  }, [logs, hasMore, nextTime, nextId, query.isFetching]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !currentHasMore || !currentNextTime || !currentNextId) return;
    setLoadingMore(true);
    try {
      const { listVaultAccessLogs } = await import("@/services/vault-service");
      const page = await listVaultAccessLogs({
        action: action === "all" ? undefined : action,
        limit: PAGE_SIZE,
        nextTime: currentNextTime,
        nextId: currentNextId,
      });
      setPagedLogs((prev) => [...prev, ...page.logs]);
      setCurrentHasMore(page.hasMore);
      setCurrentNextTime(page.nextTime);
      setCurrentNextId(page.nextId);
    } catch (err) {
      toast.error(getDisplayErrorMessage(err, t("error.generic")));
    } finally {
      setLoadingMore(false);
    }
  }, [action, currentHasMore, currentNextId, currentNextTime, loadingMore, t]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[15px] leading-7 text-muted-foreground max-w-3xl">
          {t("vault.logs.description")}
        </p>
        <Select value={action} onValueChange={(v) => setAction(v as FilterAction)}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder={t("vault.logs.filter.action")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("vault.logs.filter.actionAll")}</SelectItem>
            {LOG_ACTION_ORDER.map((a) => {
              const key = ACTION_LABEL_KEY[a];
              return (
                <SelectItem key={a} value={a}>
                  {key ? t(key) : a}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {query.isLoading
        ? <LogsSkeleton />
        : pagedLogs.length === 0
          ? <EmptyLogs />
          : (
            <>
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr className="text-left">
                      <th className="px-4 py-2.5 font-medium w-[170px]">时间</th>
                      <th className="px-4 py-2.5 font-medium w-[160px]">{t("vault.logs.filter.action")}</th>
                      <th className="px-4 py-2.5 font-medium w-[90px]">来源</th>
                      <th className="px-4 py-2.5 font-medium w-[90px]">结果</th>
                      <th className="px-4 py-2.5 font-medium">详情</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pagedLogs.map((log) => (
                      <LogRow key={log.id} log={log} formatDateTime={formatDateTime} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-center">
                {currentHasMore ? (
                  <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? t("vault.logs.loadingMore") : t("vault.logs.loadMore")}
                  </Button>
                ) : null}
              </div>
            </>
          )}
    </div>
  );
}

interface LogRowProps {
  log: VaultAccessLog;
  formatDateTime: ReturnType<typeof useI18n>["formatDateTime"];
}

function LogRow({ log, formatDateTime }: LogRowProps) {
  const { t } = useI18n();
  const actionLabelKey = (log.action as VaultLogAction) in ACTION_LABEL_KEY
    ? ACTION_LABEL_KEY[log.action as VaultLogAction]
    : undefined;
  const actionLabel = actionLabelKey ? t(actionLabelKey) : log.action;
  const actionIcon = actionIconFor(log.action);
  const source = log.source === "admin"
    ? (
      <Badge variant="outline">
        <Shield className="h-3.5 w-3.5 mr-1" />
        {t("vault.logs.source.admin")}
      </Badge>
    )
    : (
      <Badge variant="secondary">
        <Globe2 className="h-3.5 w-3.5 mr-1" />
        {t("vault.logs.source.public")}
      </Badge>
    );
  const result = log.result === "success"
    ? (
      <Badge variant="default" className="bg-success/15 text-success hover:bg-success/15">
        <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
        {t("vault.logs.result.success")}
      </Badge>
    )
    : (
      <Badge variant="destructive">
        <XCircle className="h-3.5 w-3.5 mr-1" />
        {t("vault.logs.result.failure")}
      </Badge>
    );
  let reason: string | undefined;
  if (log.detail && typeof log.detail === "object" && "reason" in log.detail) {
    const raw = (log.detail as Record<string, unknown>)["reason"];
    if (raw !== undefined && raw !== null) {
      reason = t("vault.logs.detail.reason", { reason: String(raw) });
    }
  }
  return (
    <tr className="align-top">
      <td className="px-4 py-3 text-muted-foreground tabular-nums whitespace-nowrap">
        {formatDateTime(log.createdAt)}
      </td>
      <td className="px-4 py-3 text-foreground whitespace-nowrap">
        <span className="inline-flex items-center">
          {actionIcon}
          <span className="ml-1.5">{actionLabel}</span>
        </span>
      </td>
      <td className="px-4 py-3">{source}</td>
      <td className="px-4 py-3">{result}</td>
      <td className="px-4 py-3 text-muted-foreground">
        <div className="flex flex-wrap gap-2 text-xs">
          {log.subscriptionId ? (
            <span className="rounded-md border border-border px-2 py-0.5">sub {shortId(log.subscriptionId)}</span>
          ) : null}
          {log.credentialId ? (
            <span className="rounded-md border border-border px-2 py-0.5">cred {shortId(log.credentialId)}</span>
          ) : null}
          {log.codeId ? (
            <span className="rounded-md border border-border px-2 py-0.5">code {shortId(log.codeId)}</span>
          ) : null}
          {log.ip ? <span className="rounded-md border border-border px-2 py-0.5 font-mono">{log.ip}</span> : null}
          {reason ? (
            <span className="rounded-md border border-muted-foreground/30 bg-muted/30 px-2 py-0.5 text-muted-foreground">
              {reason}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function actionIconFor(action: string) {
  switch (action) {
    case "credential_viewed": return <Eye className="h-4 w-4 text-amber" />;
    case "credential_created": return <CheckCircle2 className="h-4 w-4 text-green" />;
    case "credential_updated": return <Activity className="h-4 w-4 text-blue-500" />;
    case "credential_deleted": return <XCircle className="h-4 w-4 text-destructive" />;
    case "code_generated": return <Shield className="h-4 w-4 text-green" />;
    case "code_redeemed": return <CheckCircle2 className="h-4 w-4 text-green" />;
    case "code_revoked": return <XCircle className="h-4 w-4 text-destructive" />;
    case "request_submitted": return <AlertCircle className="h-4 w-4 text-amber" />;
    case "request_approved": return <CheckCircle2 className="h-4 w-4 text-green" />;
    case "request_declined": return <XCircle className="h-4 w-4 text-destructive" />;
    case "request_closed": return <XCircle className="h-4 w-4 text-muted-foreground" />;
    default: return <Activity className="h-4 w-4 text-muted-foreground" />;
  }
}

function LogsSkeleton() {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="px-4 py-3 border-b border-border last:border-b-0 flex items-center gap-3">
          <Skeleton className="h-4 w-40 tabular-nums" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-4 w-60 flex-1" />
        </div>
      ))}
    </div>
  );
}

function EmptyLogs() {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-card/40 p-10 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted/50">
        <Activity className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="text-[15px] font-medium">{t("vault.logs.empty")}</div>
    </div>
  );
}
