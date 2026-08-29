/**
 * 账号库凭据卡片。
 *
 * 架构位置：只封装单条凭据的展示与即时操作（reveal/复制/编辑/删除入口）；
 * 明文密码 reveal 后 30 秒自动隐藏，且绝不写入组件外状态。
 */
import { useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nProvider";
import { useRevealVaultCredentialPassword } from "@/hooks/use-vault";
import { copyTextToClipboard } from "@/shared/browser/clipboard";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import type { VaultCredential } from "@renewlet/shared/schemas/vault";

const PASSWORD_AUTO_HIDE_MS = 30_000;

export interface VaultCredentialCardProps {
  credential: VaultCredential;
  /** 关联订阅名；未关联时为 null。 */
  subscriptionName: string | null;
  onEdit: (credential: VaultCredential) => void;
  onDelete: (credential: VaultCredential) => void;
}

export function VaultCredentialCard({ credential, subscriptionName, onEdit, onDelete }: VaultCredentialCardProps) {
  const { t } = useI18n();
  const revealMutation = useRevealVaultCredentialPassword();
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoHideTimer = () => {
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }
  };

  useEffect(() => clearAutoHideTimer, []);

  const scheduleAutoHide = () => {
    clearAutoHideTimer();
    autoHideTimer.current = setTimeout(() => setRevealedPassword(null), PASSWORD_AUTO_HIDE_MS);
  };

  const fetchPassword = async (signal?: AbortSignal): Promise<string | null> => {
    if (revealedPassword !== null) return revealedPassword;
    try {
      const password = await revealMutation.mutateAsync({
        credentialId: credential.id,
        ...(signal ? { signal } : {}),
      });
      setRevealedPassword(password);
      scheduleAutoHide();
      return password;
    } catch {
      toast.error(t("vault.card.revealFailed"));
      return null;
    }
  };

  const handleToggleReveal = () => {
    if (revealedPassword !== null) {
      setRevealedPassword(null);
      clearAutoHideTimer();
      return;
    }
    void fetchPassword();
  };

  const handleCopy = async (value: string | null, successHint: string) => {
    const text = value ?? (await fetchPassword());
    if (!text) return;
    const result = await copyTextToClipboard(text);
    if (result.ok) toast.success(successHint);
    else toast.error(t("vault.card.copyFailed"));
  };

  const isRevealed = revealedPassword !== null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 transition-all hover:bg-card-hover hover:shadow-lg" data-testid="vault-credential-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-foreground">{credential.title}</h3>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            {subscriptionName ? (
              <Badge variant="secondary" className="max-w-full truncate">
                {subscriptionName}
              </Badge>
            ) : null}
            {credential.url ? (
              <a
                href={credential.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
                title={t("vault.card.visitSite")}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">{credential.url}</span>
              </a>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onEdit(credential)}
                aria-label={t("vault.editCredential")}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("vault.editCredential")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(credential)}
                aria-label={t("common.delete")}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("common.delete")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="mt-3 grid gap-2">
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={credential.username}
            placeholder="—"
            className={cn("h-8 border-border bg-secondary/60 text-xs", !credential.username && "text-muted-foreground/50")}
            aria-label={t("vault.form.usernameLabel")}
          />
          {credential.username ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => void handleCopy(credential.username, t("vault.card.copied"))}
              aria-label={t("vault.card.copyUsername")}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        {credential.hasPassword ? (
          <div className="flex items-center gap-2">
            <Input
              readOnly
              type={isRevealed ? "text" : "password"}
              value={isRevealed ? (revealedPassword ?? "") : "••••••••"}
              className="h-8 border-border bg-secondary/60 pr-16 text-xs"
              aria-label={t("vault.form.passwordLabel")}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={handleToggleReveal}
              disabled={revealMutation.isPending}
              aria-label={isRevealed ? t("vault.card.hidePassword") : t("vault.card.showPassword")}
            >
              {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => void handleCopy(null, t("vault.card.copied"))}
              disabled={revealMutation.isPending}
              aria-label={t("vault.card.copyPassword")}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
