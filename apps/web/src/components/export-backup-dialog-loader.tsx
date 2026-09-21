import type { ExportBackupDialogProps } from "@/components/export-backup-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";
import { useI18n } from "@/i18n/I18nProvider";

const exportBackupDialogResource = createLazyDialogResource(() =>
  import("@/components/export-backup-dialog").then((module) => module.ExportBackupDialog),
);

export function preloadExportBackupDialog(): void {
  void exportBackupDialogResource.load().catch(() => undefined);
}

/** 导出备份对话框懒加载：vault service/query 链路不进订阅页路由闭包（bundle 预算守卫）。 */
export function DeferredExportBackupDialog(props: ExportBackupDialogProps) {
  const { t } = useI18n();
  const { value: Content, error, sessionKey } = useLazyDialogSession(props.open, exportBackupDialogResource);
  if (props.open && error) throw error;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        dismissMode="explicit"
        className="border-border bg-card"
        aria-busy={Content ? undefined : true}
        data-testid={Content ? undefined : "export-backup-dialog-loading"}
      >
        {Content ? (
          <Content key={sessionKey} {...props} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("subscriptions.exportDialogTitle")}</DialogTitle>
              <DialogDescription>{t("subscriptions.exportDialogDescription")}</DialogDescription>
            </DialogHeader>
            <DialogModulePending label={t("common.loading")} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
