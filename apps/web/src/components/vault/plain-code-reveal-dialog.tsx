// 明文授权码一次性展示弹窗：创建/审批通过后明文仅此一次可见，支持复制。
import { useRef } from "react";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useI18n } from "@/i18n/I18nProvider";
import { copyTextToClipboard } from "@/shared/browser/clipboard";

export function PlainCodeRevealDialog({
  open,
  plainCode,
  onClose,
}: {
  open: boolean;
  plainCode: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // execCommand 复制兜底需要把选区落在弹窗内的元素上：临时 textarea 挂到 body
  // 会被 Radix Dialog 的 FocusScope 抢走焦点，导致复制空选区。
  const codeRef = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("vault.codes.plain.title")}</DialogTitle>
          <DialogDescription>{t("vault.codes.plain.description")}</DialogDescription>
        </DialogHeader>
        <div className="mt-2 rounded-md border border-border bg-muted/50 px-3.5 py-3 flex items-center justify-between gap-3">
          <code ref={codeRef} tabIndex={-1} className="font-mono text-base tracking-[0.22em] text-foreground break-all select-all">{plainCode}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const result = await copyTextToClipboard(plainCode, { target: codeRef.current });
              if (result.ok) toast.success(t("vault.card.copied"));
              else toast.error(t("vault.card.copyFailed"));
            }}
          >
            <Copy className="h-4 w-4" />
            <span className="ml-1.5">{t("vault.codes.plain.copy")}</span>
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
