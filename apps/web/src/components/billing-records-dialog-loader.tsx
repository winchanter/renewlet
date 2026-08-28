import type { BillingRecordsDialogProps } from "@/components/billing-records-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogModulePending } from "@/components/ui/dialog-module-pending";
import { useI18n } from "@/i18n/I18nProvider";
import { createLazyDialogResource, useLazyDialogSession } from "@/hooks/use-lazy-dialog-session";

const billingRecordsDialogResource = createLazyDialogResource(() =>
  import("@/components/billing-records-dialog").then((module) => module.BillingRecordsDialogContent),
);

export function preloadBillingRecordsDialog(): void {
  void billingRecordsDialogResource.load().catch(() => undefined);
}

/** 历史记录代码按 intent 加载，但单次 open session 始终复用同一套 Radix Portal、焦点域和退出动画。 */
export function DeferredBillingRecordsDialog(props: BillingRecordsDialogProps) {
  const { t } = useI18n();
  const { value: Content, error, sessionKey } = useLazyDialogSession(props.open, billingRecordsDialogResource);
  if (props.open && error) throw error;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        closeLabel={t("common.close")}
        dismissMode="explicit"
        layout="content"
        className="h5-dialog-auto-frame gap-0 border-border bg-card p-0 sm:max-w-lg"
        aria-busy={!Content ? true : undefined}
        data-testid={Content ? undefined : "billing-records-dialog-module-pending"}
      >
        {Content ? (
          <Content key={sessionKey} {...props} />
        ) : (
          <>
            <DialogHeader className="shrink-0 p-6 pb-0">
              <DialogTitle className="text-xl font-semibold">{t("subscription.billingRecords.title")}</DialogTitle>
              <DialogDescription className="sr-only">
                {t("subscription.billingRecords.description")}
              </DialogDescription>
            </DialogHeader>
            <DialogModulePending label={t("common.loading")} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
