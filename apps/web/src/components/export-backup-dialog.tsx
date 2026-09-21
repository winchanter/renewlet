/**
 * 导出备份 ZIP 对话框。
 *
 * - 「包含通知密钥」沿用原“含密钥导出”语义（settings secret 是否进备份）。
 * - 「包含账号库密码」只在 Docker 运行面显示：打开时查询备份密码状态，
 *   未设置时勾选框禁用并提示去设置；已设置时勾选后必须输入备份密码，
 *   点导出先用密码解锁 POST /api/app/vault/export，失败（密码错/429）留在弹窗内展示错误并中止导出。
 *
 * 架构位置：解锁发生在弹窗内（可就地改密码重试）；拿到 envelope/凭据段后交给
 * useSubscriptionExport 的 exportBackup 组装 renewlet-export ZIP。
 */
import { useEffect, useState } from "react";
import { Archive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import { isCloudflareRuntime } from "@/services/runtime";
import { exportVaultBackup } from "@/services/vault-service";
import { useVaultBackupKeysStatus } from "@/hooks/use-vault";
import type { ExportVaultBackupOptions } from "@/modules/subscriptions/application/use-subscription-export";

export interface ExportBackupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 主导出（拉数据 + 组装 ZIP）是否进行中；进行中禁用导出按钮。 */
  exporting: boolean;
  onExport: (request: { includeSecrets: boolean; vaultBackup?: ExportVaultBackupOptions }) => void;
}

export function ExportBackupDialog({ open, onOpenChange, exporting, onExport }: ExportBackupDialogProps) {
  const { t } = useI18n();
  // 账号库凭据段只存在于 Docker/Go 运行面；Worker/Cloudflare 面完全不显示勾选。
  const vaultCapable = !isCloudflareRuntime;
  const backupKeysQuery = useVaultBackupKeysStatus(open && vaultCapable);
  const backupKeysConfigured = backupKeysQuery.data?.configured === true;

  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [includeVaultPasswords, setIncludeVaultPasswords] = useState(false);
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [vaultExportError, setVaultExportError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  // 每次打开都重建草稿：备份密码不跨会话残留，状态查询 staleTime=0 保证新鲜。
  useEffect(() => {
    if (!open) return;
    setIncludeSecrets(false);
    setIncludeVaultPasswords(false);
    setVaultPassphrase("");
    setVaultExportError(null);
    setUnlocking(false);
  }, [open]);

  const handleExport = async () => {
    setVaultExportError(null);
    let vaultBackup: ExportVaultBackupOptions | undefined;
    if (vaultCapable && includeVaultPasswords) {
      setUnlocking(true);
      try {
        // 解锁失败（备份密码错误、429 限流）时留在弹窗内展示错误，用户可改密码重试。
        const unlocked = await exportVaultBackup(vaultPassphrase);
        vaultBackup = { backupEnvelope: unlocked.backupEnvelope, vaultCredentials: unlocked.vaultCredentials };
      } catch (error) {
        setVaultExportError(getDisplayErrorMessage(error, t("subscriptions.exportVaultUnlockFailed")));
        setUnlocking(false);
        return;
      }
      setUnlocking(false);
    }
    // exactOptionalPropertyTypes 下 vaultBackup 仅在有值时作为属性传入。
    onExport(vaultBackup ? { includeSecrets, vaultBackup } : { includeSecrets });
    onOpenChange(false);
  };

  const exportDisabled = exporting
    || unlocking
    || (vaultCapable && includeVaultPasswords && (!backupKeysConfigured || vaultPassphrase.length === 0));

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Archive className="h-5 w-5 text-primary" />
          <DialogTitle>{t("subscriptions.exportDialogTitle")}</DialogTitle>
        </div>
        <DialogDescription>{t("subscriptions.exportDialogDescription")}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/20 p-3">
          <Checkbox
            id="export-include-secrets"
            checked={includeSecrets}
            onCheckedChange={(checked) => setIncludeSecrets(checked === true)}
            className="mt-0.5"
          />
          <div className="grid gap-1">
            <Label htmlFor="export-include-secrets" className="cursor-pointer text-sm font-medium text-foreground">
              {t("subscriptions.exportIncludeSecrets")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("subscriptions.exportIncludeSecretsHelp")}</p>
          </div>
        </div>

        {vaultCapable ? (
          <div className="grid gap-3 rounded-lg border border-border bg-secondary/20 p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id="export-include-vault-passwords"
                checked={includeVaultPasswords}
                onCheckedChange={(checked) => setIncludeVaultPasswords(checked === true)}
                disabled={!backupKeysConfigured}
                className="mt-0.5"
              />
              <div className="grid gap-1">
                <Label
                  htmlFor="export-include-vault-passwords"
                  className={backupKeysConfigured ? "cursor-pointer text-sm font-medium text-foreground" : "text-sm font-medium text-muted-foreground"}
                >
                  {t("subscriptions.exportIncludeVaultPasswords")}
                </Label>
                {backupKeysQuery.isPending ? (
                  <p className="text-xs text-muted-foreground">{t("subscriptions.exportVaultStatusChecking")}</p>
                ) : backupKeysConfigured ? null : (
                  <p className="text-xs text-muted-foreground">{t("subscriptions.exportVaultPasswordsNeedSetup")}</p>
                )}
              </div>
            </div>
            {includeVaultPasswords && backupKeysConfigured ? (
              <div className="grid gap-2">
                <Label htmlFor="export-vault-passphrase">{t("subscriptions.exportVaultPassphraseLabel")}</Label>
                <Input
                  id="export-vault-passphrase"
                  type="password"
                  value={vaultPassphrase}
                  onChange={(event) => setVaultPassphrase(event.target.value)}
                  className="border-border bg-background"
                  autoComplete="current-password"
                />
              </div>
            ) : null}
            {includeVaultPasswords ? (
              <p className="text-xs text-destructive">{t("subscriptions.exportVaultWarning")}</p>
            ) : null}
          </div>
        ) : null}

        {vaultExportError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {vaultExportError}
          </div>
        ) : null}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={exporting || unlocking}>
          {t("common.cancel")}
        </Button>
        <Button type="button" onClick={() => void handleExport()} disabled={exportDisabled} aria-busy={exporting || unlocking ? true : undefined}>
          {exporting || unlocking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {unlocking ? t("subscriptions.exportVaultUnlocking") : t("subscriptions.exportDialogAction")}
        </Button>
      </DialogFooter>
    </>
  );
}
