/**
 * 订阅详情弹窗的「关联账号」区块。
 *
 * 架构位置：只服务订阅详情只读视图——展示已关联凭据的名称/用户名并提供密码 reveal；
 * 完整管理（编辑、更换关联、独立账号）仍收敛到账号库页。
 */
import { useState } from "react";
import { Copy, Eye, EyeOff, ExternalLink, Plus } from "lucide-react";
import { VaultCredentialFormDialog } from "@/components/vault/credential-form-dialog";
import { Button } from "@/components/ui/button";
import { Link as RouterLink } from "@/components/router-link";
import { useI18n } from "@/i18n/I18nProvider";
import {
  useCreateVaultCredential,
  useRevealVaultCredentialPassword,
  useVaultCredentials,
} from "@/hooks/use-vault";
import { useSubscriptionGroups } from "@/hooks/use-subscription-groups";
import { useSubscriptionIndex } from "@/hooks/use-subscriptions";
import { copyTextToClipboard } from "@/shared/browser/clipboard";
import { toast } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { getDisplayErrorMessage } from "@/lib/display-error";
import type { VaultCredential } from "@renewlet/shared/schemas/vault";

interface LinkedAccountsSectionProps {
  subscriptionId: string;
}

function LinkedCredentialRow({ credential, groupName }: { credential: VaultCredential; groupName: string | null }) {
  const { t } = useI18n();
  const revealMutation = useRevealVaultCredentialPassword();
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);

  const handleToggleReveal = async () => {
    if (revealedPassword !== null) {
      setRevealedPassword(null);
      return;
    }
    try {
      const password = await revealMutation.mutateAsync({ credentialId: credential.id });
      setRevealedPassword(password);
    } catch {
      toast.error(t("vault.card.revealFailed"));
    }
  };

  const handleCopy = async (value: string | null) => {
    const text = value ?? revealedPassword;
    if (!text) return;
    const result = await copyTextToClipboard(text);
    if (result.ok) toast.success(t("vault.card.copied"));
    else toast.error(t("vault.card.copyFailed"));
  };

  return (
    <div className="grid gap-2 rounded-lg border border-border bg-secondary/40 p-3" data-testid="vault-linked-credential-row">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-foreground">
          {credential.title}
          {groupName ? (
            <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 align-middle text-[10px] font-normal text-primary">
              {t("vault.card.linkedToGroup")}
            </span>
          ) : null}
        </p>
        {credential.url ? (
          <a
            href={credential.url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
            aria-label={t("vault.card.visitSite")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>
      {credential.username ? (
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs text-muted-foreground">{credential.username}</p>
          <button
            type="button"
            onClick={() => void handleCopy(credential.username)}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={t("vault.card.copyUsername")}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      {credential.hasPassword ? (
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {revealedPassword !== null ? revealedPassword : "••••••••"}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void handleToggleReveal()}
              disabled={revealMutation.isPending}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={revealedPassword !== null ? t("vault.card.hidePassword") : t("vault.card.showPassword")}
            >
              {revealedPassword !== null ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            {revealedPassword !== null ? (
              <button
                type="button"
                onClick={() => void handleCopy(null)}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label={t("vault.card.copyPassword")}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function LinkedAccountsSection({ subscriptionId }: LinkedAccountsSectionProps) {
  const { t } = useI18n();
  const credentialsQuery = useVaultCredentials({ subscriptionId });
  const subscriptionsQuery = useSubscriptionIndex();
  const groupsQuery = useSubscriptionGroups();
  const createMutation = useCreateVaultCredential();
  const [formOpen, setFormOpen] = useState(false);

  const credentials = credentialsQuery.data ?? [];
  const groupNameById = new Map(groupsQuery.groups.map((group) => [group.id, group.name]));
  const subscriptionOptions = (subscriptionsQuery.data?.subscriptions ?? []).map((item) => ({
    id: item.id,
    name: item.name,
  }));

  return (
    <div className="grid gap-2 border-t border-border pt-3" data-testid="vault-linked-accounts-section">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("vault.detail.linkedAccounts")}</p>
        <RouterLink
          href="/vault"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
        >
          {t("vault.detail.manageInVault")}
          <ExternalLink className="h-3 w-3" />
        </RouterLink>
      </div>

      {credentialsQuery.isPending ? (
        <div className="grid gap-2">
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : credentials.length === 0 ? (
        <p className="text-xs text-muted-foreground/80">{t("vault.detail.linkedAccountsEmpty")}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {credentials.map((credential) => (
            <LinkedCredentialRow
              key={credential.id}
              credential={credential}
              groupName={credential.groupId ? groupNameById.get(credential.groupId) ?? null : null}
            />
          ))}
        </div>
      )}

      <Button
        variant="outline"
        className="w-fit border-border px-3 py-1.5 text-xs sm:w-auto"
        onClick={() => setFormOpen(true)}
        data-testid="vault-linked-add-button"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("vault.detail.addLinked")}
      </Button>

      <VaultCredentialFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        credential={null}
        defaultSubscriptionId={subscriptionId}
        subscriptions={subscriptionOptions}
        submitting={createMutation.isPending}
        onSubmit={(result) => {
          if (!result.create) return;
          createMutation.mutate(result.create, {
            onSuccess: () => {
              toast.success(t("vault.create.success"));
              setFormOpen(false);
            },
            onError: (error) => toast.error(t("vault.create.failed"), { description: getDisplayErrorMessage(error, t("error.generic")) }),
          });
        }}
      />
    </div>
  );
}
