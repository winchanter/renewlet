import { useCallback, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorState } from "@/components/query-error-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import {
  CheckCircle2,
  Clock3,
  Copy,
  Eye,
  KeyRound,
  LockKeyhole,
  Plus,
  ShieldX,
  Trash2,
} from "lucide-react";
import { useCreateVaultAccessCode, useRedeemVaultAccessCode, useRevealVaultAccessCodePlain, useRevokeVaultAccessCode, useVaultAccessCodes } from "@/hooks/use-vault-p2";
import { useVaultCredentials } from "@/hooks/use-vault";
import { PlainCodeRevealDialog } from "@/components/vault/plain-code-reveal-dialog";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey, MessageParams } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import type { SubscriptionIndexItem, VaultAccessCode, VaultCredential } from "@/types/subscription";
import { copyTextToClipboard } from "@/shared/browser/clipboard";
import { getDisplayErrorMessage } from "@/lib/display-error";

const DEFAULT_EXPIRE_HOURS = 48;
const DEFAULT_MAX_ATTEMPTS = 5;

interface AccessCodesSectionProps {
  subscriptions: Array<Pick<SubscriptionIndexItem, "id" | "name">>;
}

export function AccessCodesSection({ subscriptions }: AccessCodesSectionProps) {
  const { t, formatDateTime } = useI18n();
  const codesQuery = useVaultAccessCodes();
  const createMutation = useCreateVaultAccessCode();
  const revokeMutation = useRevokeVaultAccessCode();
  const redeemMutation = useRedeemVaultAccessCode();
  const revealPlainMutation = useRevealVaultAccessCodePlain();

  const handleViewCode = async (codeId: string) => {
    try {
      const plain = await revealPlainMutation.mutateAsync(codeId);
      setRevealedPlainCode(plain);
    } catch (err) {
      toast.error(getDisplayErrorMessage(err, t("vault.codes.viewFailed")));
    }
  };
  const credentialsQuery = useVaultCredentials();

  const [createOpen, setCreateOpen] = useState(false);
  const [revealedPlainCode, setRevealedPlainCode] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<VaultAccessCode | null>(null);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemResult, setRedeemResult] = useState<{ title: string; username: string; password: string; url: string; notes: string } | null>(null);

  const codes = codesQuery.data ?? [];
  const credentials = credentialsQuery.data ?? [];

  const handleCreateSuccess = useCallback((plain: string) => {
    setRevealedPlainCode(plain);
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[15px] leading-7 text-muted-foreground max-w-3xl">
          {t("vault.codes.description")}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setRedeemOpen(true)}>
            <KeyRound className="h-4 w-4" />
            <span className="ml-1.5">{t("vault.codes.redeem")}</span>
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={credentials.length === 0 || createMutation.isPending}>
            <Plus className="h-4 w-4" />
            <span className="ml-1.5">{t("vault.codes.create")}</span>
          </Button>
        </div>
      </div>

      {codesQuery.isLoading
        ? <AccessCodesSkeleton />
        : codesQuery.error
          ? <QueryErrorState error={codesQuery.error} onRetry={() => void codesQuery.refetch()} />
          : codes.length === 0
            ? <EmptyList />
            : (
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                {codes.map((code) => (
                <AccessCodeCard
                  key={code.id}
                  code={code}
                  subscriptions={subscriptions}
                  formatDateTime={formatDateTime}
                  onView={() => void handleViewCode(code.id)}
                  onRevoke={() => setRevoking(code)}
                />
              ))}
              </div>
            )}

      <CreateCodeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        credentials={credentials}
        submitting={createMutation.isPending}
        onSubmit={async (body) => {
          const created = await createMutation.mutateAsync(body);
          toast.success(t("vault.codes.create.success"));
          setCreateOpen(false);
          handleCreateSuccess(created.plainCode);
        }}
        onError={(err) => toast.error(getDisplayErrorMessage(err, t("vault.codes.create.failed")))}
      />

      <PlainCodeRevealDialog
        open={revealedPlainCode !== null}
        plainCode={revealedPlainCode ?? ""}
        onClose={() => setRevealedPlainCode(null)}
      />

      <AlertDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("vault.codes.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("vault.codes.revokeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async (event) => {
                event.preventDefault();
                if (!revoking) return;
                try {
                  await revokeMutation.mutateAsync(revoking.id);
                  toast.success(t("vault.codes.revokeSuccess"));
                  setRevoking(null);
                } catch (err) {
                  toast.error(getDisplayErrorMessage(err, t("error.generic")));
                }
              }}
              disabled={revokeMutation.isPending || !revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("vault.codes.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RedeemCodeDialog
        open={redeemOpen}
        onOpenChange={setRedeemOpen}
        redeeming={redeemMutation.isPending}
        onSubmit={async (body) => {
          const result = await redeemMutation.mutateAsync(body);
          setRedeemResult({
            title: result.title,
            username: result.username,
            password: result.password,
            url: result.url,
            notes: result.notes,
          });
          toast.success(t("vault.codes.redeem.success"));
        }}
        onError={(err) => toast.error(getDisplayErrorMessage(err, t("vault.codes.redeem.failed")))}
        result={redeemResult}
        onResetResult={() => setRedeemResult(null)}
      />
    </div>
  );
}

function subscriptionNameByID(
  subscriptions: Array<Pick<SubscriptionIndexItem, "id" | "name">>,
  id: string,
  t: (key: MessageKey, params?: MessageParams) => string,
) {
  if (!id) return t("vault.detail.linkedAccounts");
  const found = subscriptions.find((s) => s.id === id);
  return found?.name ?? id;
}

function StatusBadge({ status }: { status: VaultAccessCode["status"] }) {
  const { t } = useI18n();
  switch (status) {
    case "active":
      return (
        <Badge variant="default" className="bg-success/15 text-success hover:bg-success/15">
          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
          {t("vault.codes.status.active")}
        </Badge>
      );
    case "used":
      return (
        <Badge variant="secondary">
          <LockKeyhole className="h-3.5 w-3.5 mr-1" />
          {t("vault.codes.status.used")}
        </Badge>
      );
    case "revoked":
      return (
        <Badge variant="outline">
          <ShieldX className="h-3.5 w-3.5 mr-1" />
          {t("vault.codes.status.revoked")}
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="outline">
          <Clock3 className="h-3.5 w-3.5 mr-1" />
          {t("vault.codes.status.expired")}
        </Badge>
      );
  }
}

interface AccessCodeCardProps {
  code: VaultAccessCode;
  subscriptions: Array<Pick<SubscriptionIndexItem, "id" | "name">>;
  formatDateTime: (date: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  onView: () => void;
  onRevoke: () => void;
}

function AccessCodeCard({ code, subscriptions, formatDateTime, onView, onRevoke }: AccessCodeCardProps) {
  const { t } = useI18n();
  const linked = code.subscriptionId
    ? t("vault.codes.linkedSubscription", { name: subscriptionNameByID(subscriptions, code.subscriptionId, t) })
    : t("vault.codes.standaloneCredential");
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 p-4 pb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="font-mono text-xs tracking-wider text-muted-foreground">{code.codeMask}</span>
            <StatusBadge status={code.status} />
          </div>
          <CardTitle className="text-[15px] truncate">
            {code.credentialTitle || t("vault.codes.legacyCredentialTitle")}
          </CardTitle>
          <CardDescription className="text-xs">
            <span className="text-muted-foreground">{linked}</span>
            {" · "}
            {t("vault.codes.attempts", { attempts: code.attempts, maxAttempts: code.maxAttempts })}
            {code.requestId ? (
              <>
                {" · "}
                <span>{t("vault.requests.status.approved")}</span>
              </>
            ) : null}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="text-xs space-y-1 px-4 pb-3 pt-1">
        <div className="flex justify-between gap-3 text-muted-foreground">
          <span>{t("vault.codes.createdAt")}</span>
          <span className="text-muted-foreground tabular-nums whitespace-nowrap">{formatDateTime(code.createdAt, { dateStyle: "short", timeStyle: "short" })}</span>
        </div>
        <div className="flex justify-between gap-3 text-muted-foreground">
          <span>{t("vault.codes.expiresAt")}</span>
          <span className="text-muted-foreground tabular-nums whitespace-nowrap">{formatDateTime(code.expiresAt, { dateStyle: "short", timeStyle: "short" })}</span>
        </div>
        {code.note ? (
          <div className="pt-1.5 text-xs text-muted-foreground whitespace-pre-wrap break-words">{code.note}</div>
        ) : null}
      </CardContent>
      <CardFooter className="mt-auto justify-end gap-2 px-4 pb-4 pt-0">
        {code.hasPlainCode && (
          <Button size="sm" variant="outline" onClick={onView}>
            <Eye className="h-4 w-4" />
            <span className="ml-1.5">{t("vault.codes.viewCode")}</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className={cn(
            "text-destructive hover:bg-destructive/10 hover:text-destructive",
            code.status !== "active" && "opacity-50",
          )}
          disabled={code.status !== "active"}
          onClick={onRevoke}
        >
          <Trash2 className="h-4 w-4" />
          <span className="ml-1.5">{t("vault.codes.revoke")}</span>
        </Button>
      </CardFooter>
    </Card>
  );
}

function AccessCodesSkeleton() {
  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-60" />
          <Skeleton className="h-4 w-48" />
          <div className="pt-3 flex justify-end"><Skeleton className="h-8 w-20" /></div>
        </div>
      ))}
    </div>
  );
}

function EmptyList() {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-card/40 p-10 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted/50">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="text-[15px] font-medium">{t("vault.codes.empty")}</div>
    </div>
  );
}

// ============== 创建授权码弹窗 ==============

interface CreateCodeDraft {
  credentialId: string;
  expireHours: number;
  maxAttempts: number;
  note: string;
}

interface CreateCodeDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  credentials: VaultCredential[];
  submitting: boolean;
  onSubmit: (body: { credentialId: string; expireHours?: number; maxAttempts?: number; note?: string }) => Promise<void>;
  onError: (err: unknown) => void;
  /** 锁定绑定账号（账号卡片入口）：预选该账号且不可修改。 */
  lockedCredentialId?: string | undefined;
}

export function CreateCodeDialog({
  open,
  onOpenChange,
  credentials,
  submitting,
  onSubmit,
  onError,
  lockedCredentialId,
}: CreateCodeDialogProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CreateCodeDraft>({
    credentialId: lockedCredentialId ?? credentials[0]?.id ?? "",
    expireHours: DEFAULT_EXPIRE_HOURS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    note: "",
  });

  // 当 credentials 更新（首次加载）时，自动回填首个可用选项（避免 defaultValue=空 持续到加载后）；
  // 锁定账号模式下 credentialId 由调用方指定，不参与回填。
  const prevLen = useRef(0);
  const firstCredential = credentials.length > 0 ? credentials[0] : undefined;
  if (!lockedCredentialId && firstCredential && prevLen.current === 0 && draft.credentialId === "") {
    const firstId = firstCredential.id;
    setDraft((d) => ({ ...d, credentialId: firstId }));
  }
  prevLen.current = credentials.length;

  const canSubmit = draft.credentialId.trim().length > 0 && draft.expireHours > 0 && draft.maxAttempts > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissMode="explicit"
        className="max-w-md border-border bg-card"
      >
        <DialogHeader>
          <DialogTitle>{t("vault.codes.createTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label>{t("vault.codes.form.credentialLabel")}</Label>
            <Select
              value={draft.credentialId}
              onValueChange={(v) => setDraft({ ...draft, credentialId: v })}
              disabled={Boolean(lockedCredentialId)}
            >
              <SelectTrigger className={cn(lockedCredentialId && "cursor-not-allowed bg-secondary/60")}>
                <SelectValue placeholder={t("vault.codes.form.credentialPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {credentials.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("vault.codes.form.expireHoursLabel")}</Label>
              <Input
                type="number"
                min={1}
                max={168}
                value={String(draft.expireHours)}
                onChange={(e) => setDraft({ ...draft, expireHours: Math.max(1, Math.min(168, Number(e.target.value) || 0)) })}
                placeholder={t("vault.codes.form.expireHoursPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("vault.codes.form.maxAttemptsLabel")}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={String(draft.maxAttempts)}
                onChange={(e) => setDraft({ ...draft, maxAttempts: Math.max(1, Math.min(100, Number(e.target.value) || 0)) })}
                placeholder={t("vault.codes.form.maxAttemptsPlaceholder")}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("vault.codes.form.noteLabel")}</Label>
            <Textarea
              rows={3}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder={t("vault.codes.form.notePlaceholder")}
              maxLength={500}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>{t("common.cancel")}</Button>
          <Button
            disabled={!canSubmit}
            onClick={async () => {
              if (!canSubmit) return;
              try {
                const body: { credentialId: string; expireHours?: number; maxAttempts?: number; note?: string } = {
                  credentialId: draft.credentialId.trim(),
                };
                if (draft.expireHours !== DEFAULT_EXPIRE_HOURS) body.expireHours = draft.expireHours;
                if (draft.maxAttempts !== DEFAULT_MAX_ATTEMPTS) body.maxAttempts = draft.maxAttempts;
                if (draft.note.trim() !== "") body.note = draft.note.trim();
                await onSubmit(body);
              } catch (err) {
                onError(err);
              }
            }}
          >
            {t("vault.codes.generate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============== 授权码解锁弹窗 ==============

interface RedeemCodeDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  redeeming: boolean;
  onSubmit: (body: { code: string }) => Promise<void>;
  onError: (err: unknown) => void;
  result: { title: string; username: string; password: string; url: string; notes: string } | null;
  onResetResult: () => void;
}

function RedeemCodeDialog({
  open,
  onOpenChange,
  redeeming,
  onSubmit,
  onError,
  result,
  onResetResult,
}: RedeemCodeDialogProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ code: string }>({ code: "" });

  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleAutoHide = useCallback((hide: () => void) => {
    if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    autoHideTimer.current = setTimeout(hide, 60_000);
  }, []);

  const handleClosed = (o: boolean) => {
    if (!o) {
      onResetResult();
      setDraft({ code: "" });
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    }
    onOpenChange(o);
  };

  const canSubmit = draft.code.trim().length > 0 && !redeeming;

  return (
    <Dialog open={open} onOpenChange={handleClosed}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("vault.codes.redeemTitle")}</DialogTitle>
        </DialogHeader>
        {result === null ? (
          <>
            <div className="space-y-4 pt-1">
              <div className="space-y-1.5">
                <Label>{t("vault.codes.redeem.codeLabel")}</Label>
                <Input
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value.toLowerCase().replace(/\s+/g, "") })}
                  placeholder={t("vault.codes.redeem.codePlaceholder")}
                  className="font-mono tracking-widest"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => handleClosed(false)} disabled={redeeming}>{t("common.cancel")}</Button>
              <Button
                disabled={!canSubmit}
                onClick={async () => {
                  if (!canSubmit) return;
                  try {
                    await onSubmit({ code: draft.code.trim() });
                    scheduleAutoHide(() => onResetResult());
                  } catch (err) {
                    onError(err);
                  }
                }}
              >
                <LockKeyhole className="h-4 w-4" />
                <span className="ml-1.5">{redeeming ? t("common.loading") : t("vault.codes.unlock")}</span>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <RedeemResultView result={result} onClose={() => handleClosed(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RedeemResultView({
  result,
  onClose,
}: {
  result: { title: string; username: string; password: string; url: string; notes: string };
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
        <div className="text-sm font-medium">{result.title}</div>
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
          <div>
            <div className="text-xs text-muted-foreground">{t("vault.form.usernameLabel")}</div>
            <div className="font-mono text-sm break-all">{result.username || "—"}</div>
          </div>
          <CopyField value={result.username} />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
          <div>
            <div className="text-xs text-muted-foreground">{t("vault.form.passwordLabel")}</div>
            <div className="font-mono text-sm break-all">{result.password || "—"}</div>
          </div>
          <CopyField value={result.password} onCopied={() => toast.success(t("vault.codes.redeem.passwordCopied"))} />
        </div>
        {result.url ? (
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("vault.form.urlLabel")}</div>
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm break-all underline-offset-4 hover:underline"
            >
              {result.url}
            </a>
          </div>
        ) : null}
        {result.notes ? (
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <div className="text-xs text-muted-foreground">{t("vault.form.notesLabel")}</div>
            <div className="text-sm whitespace-pre-wrap break-words">{result.notes}</div>
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogFooter>
    </div>
  );
}

function CopyField({ value, onCopied }: { value: string; onCopied?: () => void }) {
  const { t } = useI18n();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!value}
      onClick={async () => {
        const result = await copyTextToClipboard(value);
        if (result.ok) {
          if (onCopied) onCopied();
          else toast.success(t("vault.card.copied"));
        } else toast.error(t("vault.card.copyFailed"));
      }}
    >
      <Copy className="h-4 w-4" />
    </Button>
  );
}
