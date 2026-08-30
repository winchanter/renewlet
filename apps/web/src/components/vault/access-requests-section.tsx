import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import {
  CheckCircle2,
  Clock3,
  FileCheck2,
  Loader2,
  MessageSquare,
  XCircle,
  XSquare,
} from "lucide-react";
import { useDecideVaultAccessRequest, useVaultAccessRequests } from "@/hooks/use-vault-p2";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import type { SubscriptionIndexItem, VaultAccessRequest, VaultCredential } from "@/types/subscription";
import { copyTextToClipboard } from "@/shared/browser/clipboard";
import { getDisplayErrorMessage } from "@/lib/display-error";

type RequestsStatusFilter = "all" | "pending";

interface AccessRequestsSectionProps {
  subscriptions: Array<Pick<SubscriptionIndexItem, "id" | "name">>;
  credentials: VaultCredential[];
}

export function AccessRequestsSection({ subscriptions, credentials }: AccessRequestsSectionProps) {
  const { t, formatDateTime } = useI18n();
  const [statusFilter, setStatusFilter] = useState<RequestsStatusFilter>("all");
  const [deciding, setDeciding] = useState<{ request: VaultAccessRequest; action: "approve" | "decline" | "close" } | null>(null);

  const queryFilter = statusFilter === "pending" ? "pending" : "all";
  const requestsQuery = useVaultAccessRequests({ status: queryFilter });
  const decideMutation = useDecideVaultAccessRequest();

  const requests = requestsQuery.data ?? [];
  const pendingCount = useMemo(
    () => requests.filter((r) => r.status === "pending").length,
    [requests],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[15px] leading-7 text-muted-foreground max-w-3xl">
          {t("vault.requests.description")}
        </p>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs">
            <MessageSquare className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <span>{t("vault.requests.pendingBadge", { count: pendingCount })}</span>
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as RequestsStatusFilter)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("vault.requests.filter.statusAll")}</SelectItem>
              <SelectItem value="pending">{t("vault.requests.filter.onlyPending")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {requestsQuery.isLoading
        ? <RequestsSkeleton />
        : requests.length === 0
          ? <EmptyRequests />
          : (
            <div className="grid gap-3 grid-cols-1">
              {requests.map((req) => (
                <RequestCard
                  key={req.id}
                  request={req}
                  subscriptionName={subscriptions.find((s) => s.id === req.subscriptionId)?.name ?? req.subscriptionId}
                  formatDateTime={formatDateTime}
                  onDecide={(action) => setDeciding({ request: req, action })}
                />
              ))}
            </div>
          )}

      <DecideDialog
        open={deciding !== null}
        onOpenChange={(o) => !o && setDeciding(null)}
        request={deciding?.request ?? null}
        action={deciding?.action ?? "approve"}
        credentials={credentials}
        submitting={decideMutation.isPending}
        onSubmit={async (body) => {
          if (!deciding) return;
          try {
            const result = await decideMutation.mutateAsync({ requestId: deciding.request.id, body });
            const key: MessageKey =
              deciding.action === "approve"
                ? "vault.requests.approve.success"
                : deciding.action === "decline"
                  ? "vault.requests.decline.success"
                  : "vault.requests.close.success";
            toast.success(t(key));
            setDeciding(null);
            if (deciding.action === "approve" && result.plainCode) {
              const copyResult = await copyTextToClipboard(result.plainCode);
              if (!copyResult.ok) {
                // eslint-disable-next-line no-alert
                window.alert(`${t("vault.codes.plain.title")}:\n\n${result.plainCode}`);
              } else {
                toast.success(t("vault.card.copied"));
              }
            }
          } catch (err) {
            toast.error(getDisplayErrorMessage(err, t("vault.requests.decide.failed")));
          }
        }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: VaultAccessRequest["status"] }) {
  const { t } = useI18n();
  switch (status) {
    case "pending":
      return (
        <Badge variant="secondary">
          <Clock3 className="h-3.5 w-3.5 mr-1" />
          {t("vault.requests.status.pending")}
        </Badge>
      );
    case "approved":
      return (
        <Badge variant="default" className="bg-success/15 text-success hover:bg-success/15">
          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
          {t("vault.requests.status.approved")}
        </Badge>
      );
    case "declined":
      return (
        <Badge variant="outline">
          <XCircle className="h-3.5 w-3.5 mr-1" />
          {t("vault.requests.status.declined")}
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="outline">
          <Clock3 className="h-3.5 w-3.5 mr-1" />
          {t("vault.requests.status.expired")}
        </Badge>
      );
    case "closed":
      return (
        <Badge variant="outline">
          <XSquare className="h-3.5 w-3.5 mr-1" />
          {t("vault.requests.status.closed")}
        </Badge>
      );
  }
}

interface RequestCardProps {
  request: VaultAccessRequest;
  subscriptionName: string;
  formatDateTime: (date: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  onDecide: (action: "approve" | "decline" | "close") => void;
}

function RequestCard({ request, subscriptionName, formatDateTime, onDecide }: RequestCardProps) {
  const { t } = useI18n();
  const pending = request.status === "pending";
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <StatusBadge status={request.status} />
            <Badge variant="outline">
              <FileCheck2 className="h-3.5 w-3.5 mr-1" />
              {t("vault.requests.fromPublicPage")}
            </Badge>
          </div>
          <CardTitle className="text-[15px]">{subscriptionName}</CardTitle>
          <CardDescription className="text-xs">{formatDateTime(request.createdAt)}</CardDescription>
        </div>
        {pending && (
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              className="bg-success/15 text-success hover:bg-success/25"
              onClick={() => onDecide("approve")}
            >
              <CheckCircle2 className="h-4 w-4" />
              <span className="ml-1.5">{t("vault.requests.approve")}</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDecide("decline")}>
              <XCircle className="h-4 w-4" />
              <span className="ml-1.5">{t("vault.requests.decline")}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDecide("close")}>
              {t("vault.requests.close")}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {request.note ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="text-xs text-muted-foreground mb-0.5">{t("vault.requests.noteLabel")}</div>
            <div className="whitespace-pre-wrap break-words">{request.note}</div>
          </div>
        ) : (
          <div className="text-muted-foreground italic">— {t("vault.requests.empty")} —</div>
        )}
        {request.decidedAt ? (
          <div className="text-xs text-muted-foreground flex items-center gap-3">
            <span>{formatDateTime(request.decidedAt)}</span>
            {request.codeId ? <span className="font-mono text-foreground">code id={request.codeId.slice(0, 12)}…</span> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RequestsSkeleton() {
  return (
    <div className="grid gap-3 grid-cols-1">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-28 rounded-full" />
          </div>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-12 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}

function EmptyRequests() {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-card/40 p-10 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted/50">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="text-[15px] font-medium">{t("vault.requests.empty")}</div>
    </div>
  );
}

// ============== 决策弹窗 ==============

interface DecideDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  request: VaultAccessRequest | null;
  action: "approve" | "decline" | "close";
  credentials: VaultCredential[];
  submitting: boolean;
  onSubmit: (body: {
    action: "approve" | "decline" | "close";
    credentialId?: string;
    note?: string;
    expireHours?: number;
    maxAttempts?: number;
  }) => Promise<void>;
}

function DecideDialog({
  open,
  onOpenChange,
  request,
  action,
  credentials,
  submitting,
  onSubmit,
}: DecideDialogProps) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [expireHours, setExpireHours] = useState(48);
  const [maxAttempts, setMaxAttempts] = useState(5);
  const [credentialId, setCredentialId] = useState("");

  // 切换 request / 打开审批时，重置账号选择（避免跨 request 缓存了错误 credentialId）
  const lastContext = useRef<{ open: boolean; requestId: string | null; action: typeof action } | null>(null);
  useEffect(() => {
    const ctx = { open, requestId: request?.id ?? null, action };
    const prev = lastContext.current;
    if (
      open &&
      action === "approve" &&
      (!prev || !prev.open || prev.requestId !== ctx.requestId || prev.action !== ctx.action)
    ) {
      setCredentialId("");
    }
    lastContext.current = ctx;
  }, [open, request?.id, action]);

  const titleKey: MessageKey =
    action === "approve"
      ? "vault.requests.approve"
      : action === "decline"
        ? "vault.requests.decline"
        : "vault.requests.close";

  const subscriptionCredentials =
    action === "approve" && request
      ? credentials.filter((c) => c.subscriptionId === request.subscriptionId)
      : [];
  const noCredentialsForSubscription = action === "approve" && subscriptionCredentials.length === 0;
  const canSubmit =
    !submitting &&
    (action !== "approve" || credentialId.trim().length > 0);

  const descriptionId: MessageKey | null =
    action === "approve"
      ? "vault.requests.approve.description"
      : action === "decline"
        ? "vault.requests.decline.description"
        : null;

  const submitLabel =
    action === "approve"
      ? t("vault.requests.approve")
      : action === "decline"
        ? t("vault.requests.decline")
        : t("vault.requests.close");

  const variant =
    action === "approve"
      ? "default"
      : action === "decline"
        ? "outline"
        : "ghost";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissMode="explicit"
        layout="frame"
        className="h5-dialog-frame h5-subscription-dialog-panel max-w-md border-border bg-card p-0"
      >
        <DialogHeader className="shrink-0 px-6 pb-3 pt-5 pr-12">
          <DialogTitle>{t("vault.requests.decideTitle")} — {t(titleKey)}</DialogTitle>
          {descriptionId ? (
            <p className="text-sm text-muted-foreground pt-1">{t(descriptionId)}</p>
          ) : null}
        </DialogHeader>
        <div className="h5-subscription-dialog-scroll min-h-0 space-y-3 overflow-y-auto px-6 pb-4 pt-1">
          {request?.note ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
              <div className="text-xs text-muted-foreground mb-0.5">
                {t("vault.requests.noteLabel")}
              </div>
              <div className="whitespace-pre-wrap break-words text-sm">{request.note}</div>
            </div>
          ) : null}
          {action === "approve" && (
            noCredentialsForSubscription ? (
              <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                {t("vault.requests.form.noCredentialsForSubscription")}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>{t("vault.requests.form.credentialLabel")}</Label>
                <Select value={credentialId} onValueChange={setCredentialId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("vault.requests.form.credentialPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {subscriptionCredentials.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          )}
          {action === "approve" && !noCredentialsForSubscription && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("vault.requests.form.expireHoursLabel")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={168}
                  value={String(expireHours)}
                  onChange={(e) => setExpireHours(Math.max(1, Math.min(168, Number(e.target.value) || 0)))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("vault.requests.form.maxAttemptsLabel")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={String(maxAttempts)}
                  onChange={(e) => setMaxAttempts(Math.max(1, Math.min(100, Number(e.target.value) || 0)))}
                />
              </div>
            </div>
          )}
          {(action === "approve" || action === "decline") && (
            <div className="space-y-1.5">
              <Label>{t("vault.requests.form.noteLabel")}</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </div>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={variant}
            className={cn(variant === "default" && "bg-success/15 text-success hover:bg-success/25")}
            disabled={!canSubmit}
            onClick={async () => {
              if (!canSubmit) return;
              const body: Parameters<typeof onSubmit>[0] = { action };
              if (note.trim()) body.note = note.trim();
              if (action === "approve") {
                body.credentialId = credentialId.trim();
                body.expireHours = expireHours;
                body.maxAttempts = maxAttempts;
              }
              await onSubmit(body);
            }}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            <span className="ml-1.5">{submitLabel}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
