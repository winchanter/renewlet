/**
 * 设置页「备份密码」区块（账号库备份恢复）。
 *
 * 三种状态：
 * - 未设置：说明文案 + 设置入口（passphrase + 确认输入）。
 * - 已设置：修改（当前密码 + 新密码）与删除（当前密码确认）。
 * - 成功后由 react-query 失效自动刷新 GET /api/app/vault/backup-keys 状态。
 *
 * 架构位置：备份密码不是 AppSettings，独立走 vault backup-keys API；
 * 错误文案优先展示后端返回的可读原因（如「备份密码错误」）。
 */
import { useCallback, useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButtonContent } from "./settings-shared-controls";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import { useI18n } from "@/i18n/I18nProvider";
import { getDisplayErrorMessage } from "@/lib/display-error";
import {
  useCreateVaultBackupKey,
  useDeleteVaultBackupKey,
  useUpdateVaultBackupKey,
  useVaultBackupKeysStatus,
} from "@/hooks/use-vault";

type VaultBackupDialogMode = "set" | "change" | "delete";

/** 备份密码长度边界，与 Go 端 passphrase 8-256 校验保持一致。 */
const BACKUP_PASSPHRASE_MIN_LENGTH = 8;
const BACKUP_PASSPHRASE_MAX_LENGTH = 256;

export function VaultBackupPasswordSection() {
  const { t } = useI18n();
  const statusQuery = useVaultBackupKeysStatus();
  const configured = statusQuery.data?.configured === true;

  const [dialogMode, setDialogMode] = useState<VaultBackupDialogMode | null>(null);
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const createMutation = useCreateVaultBackupKey();
  const updateMutation = useUpdateVaultBackupKey();
  const deleteMutation = useDeleteVaultBackupKey();

  const resetDialogForm = useCallback(() => {
    setCurrentPassphrase("");
    setPassphrase("");
    setConfirmPassphrase("");
  }, []);
  const { scheduleCleanup, cancelCleanup } = useDeferredDialogCleanup(resetDialogForm);

  const openDialog = (mode: VaultBackupDialogMode) => {
    cancelCleanup();
    resetDialogForm();
    setDialogMode(mode);
  };
  const closeDialog = (open: boolean) => {
    if (open) return;
    // 关闭动画期间保留输入内容，动画结束后再清空，避免布局闪烁。
    scheduleCleanup();
    setDialogMode(null);
  };

  const handleSubmit = async () => {
    if (submitting || dialogMode === null) return;
    if (dialogMode === "set") {
      if (passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH || passphrase.length > BACKUP_PASSPHRASE_MAX_LENGTH) {
        toast.error(t("settings.vaultBackup.passphraseLengthInvalid"));
        return;
      }
      if (passphrase !== confirmPassphrase) {
        toast.error(t("settings.vaultBackup.passphraseMismatch"));
        return;
      }
      setSubmitting(true);
      try {
        await createMutation.mutateAsync(passphrase);
        toast.success(t("settings.vaultBackup.setSuccess"));
        scheduleCleanup();
        setDialogMode(null);
      } catch (error) {
        toast.error(getDisplayErrorMessage(error, t("settings.vaultBackup.failed")));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (dialogMode === "change") {
      if (!currentPassphrase) {
        toast.error(t("settings.vaultBackup.currentRequired"));
        return;
      }
      if (passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH || passphrase.length > BACKUP_PASSPHRASE_MAX_LENGTH) {
        toast.error(t("settings.vaultBackup.passphraseLengthInvalid"));
        return;
      }
      setSubmitting(true);
      try {
        await updateMutation.mutateAsync({ currentPassphrase, newPassphrase: passphrase });
        toast.success(t("settings.vaultBackup.changeSuccess"));
        scheduleCleanup();
        setDialogMode(null);
      } catch (error) {
        toast.error(getDisplayErrorMessage(error, t("settings.vaultBackup.failed")));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    // delete 模式需要输入当前备份密码确认。
    if (!currentPassphrase) {
      toast.error(t("settings.vaultBackup.currentRequired"));
      return;
    }
    setSubmitting(true);
    try {
      await deleteMutation.mutateAsync(currentPassphrase);
      toast.success(t("settings.vaultBackup.deleteSuccess"));
      scheduleCleanup();
      setDialogMode(null);
    } catch (error) {
      toast.error(getDisplayErrorMessage(error, t("settings.vaultBackup.failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const dialogTitle = dialogMode === "set"
    ? t("settings.vaultBackup.setTitle")
    : dialogMode === "change"
      ? t("settings.vaultBackup.changeTitle")
      : t("settings.vaultBackup.deleteTitle");
  const dialogDescription = dialogMode === "set"
    ? t("settings.vaultBackup.setDescription")
    : dialogMode === "change"
      ? t("settings.vaultBackup.changeDescription")
      : t("settings.vaultBackup.deleteDescription");
  const submitLabel = dialogMode === "set"
    ? t("settings.vaultBackup.setAction")
    : dialogMode === "change"
      ? t("settings.vaultBackup.changeAction")
      : t("settings.vaultBackup.deleteAction");

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-primary" />
        <h3 className="text-base font-semibold text-foreground">{t("settings.vaultBackup.title")}</h3>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{t("settings.vaultBackup.description")}</p>

      {statusQuery.isPending ? (
        <div className="rounded-lg border border-border bg-secondary/30 p-4 text-sm text-muted-foreground">
          {t("settings.vaultBackup.statusChecking")}
        </div>
      ) : statusQuery.isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {t("settings.vaultBackup.statusFailed")}
        </div>
      ) : configured ? (
        <div className="grid gap-3">
          <p className="text-sm text-foreground">{t("settings.vaultBackup.configuredHint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="border-border" onClick={() => openDialog("change")}>
              {t("settings.vaultBackup.changeAction")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => openDialog("delete")}
            >
              {t("settings.vaultBackup.deleteAction")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm text-foreground">{t("settings.vaultBackup.unconfiguredHint")}</p>
          <div>
            <Button type="button" className="bg-primary text-primary-foreground hover:bg-primary-glow" onClick={() => openDialog("set")}>
              {t("settings.vaultBackup.setAction")}
            </Button>
          </div>
          <p className="text-xs text-destructive">{t("settings.vaultBackup.warning")}</p>
        </div>
      )}

      <Dialog open={dialogMode !== null} onOpenChange={closeDialog}>
        <DialogContent dismissMode="explicit" className="border-border bg-card">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            {dialogMode === "change" || dialogMode === "delete" ? (
              <div className="grid gap-2">
                <Label htmlFor="vaultBackupCurrentPassphrase">{t("settings.vaultBackup.currentPassphraseLabel")}</Label>
                <Input
                  id="vaultBackupCurrentPassphrase"
                  type="password"
                  value={currentPassphrase}
                  onChange={(event) => setCurrentPassphrase(event.target.value)}
                  className="border-border bg-secondary"
                  autoComplete="current-password"
                />
              </div>
            ) : null}
            {dialogMode === "set" || dialogMode === "change" ? (
              <div className="grid gap-2">
                <Label htmlFor="vaultBackupPassphrase">
                  {dialogMode === "set" ? t("settings.vaultBackup.passphraseLabel") : t("settings.vaultBackup.newPassphraseLabel")}
                </Label>
                <Input
                  id="vaultBackupPassphrase"
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  className="border-border bg-secondary"
                  autoComplete="new-password"
                />
              </div>
            ) : null}
            {dialogMode === "set" ? (
              <div className="grid gap-2">
                <Label htmlFor="vaultBackupPassphraseConfirm">{t("settings.vaultBackup.confirmPassphraseLabel")}</Label>
                <Input
                  id="vaultBackupPassphraseConfirm"
                  type="password"
                  value={confirmPassphrase}
                  onChange={(event) => setConfirmPassphrase(event.target.value)}
                  className="border-border bg-secondary"
                  autoComplete="new-password"
                />
                <p className="text-xs text-destructive">{t("settings.vaultBackup.warning")}</p>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => closeDialog(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={() => void handleSubmit()} disabled={submitting} aria-busy={submitting ? true : undefined}>
              <LoadingButtonContent loading={submitting} loadingLabel={t("common.saving")}>
                {submitLabel}
              </LoadingButtonContent>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
