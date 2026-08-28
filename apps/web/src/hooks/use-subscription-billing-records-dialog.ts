import { useCallback, useMemo, useState } from "react";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import { useDialogSessionSnapshot } from "@/hooks/use-dialog-session-snapshot";
import {
  createSubscriptionDialogTarget,
  type SubscriptionDialogTarget,
} from "@/hooks/subscription-dialog-target";
import type { SubscriptionCollectionItem } from "@/types/subscription";

/**
 * 历史记录弹窗会话：只保存列表快照目标，不拉取订阅详情——
 * 记录行所需数据全部来自 billing-records 查询，头部信息由 collectionItem 快照提供。
 */
export function useSubscriptionBillingRecordsDialog(subscriptions: readonly SubscriptionCollectionItem[]) {
  const [target, setTarget] = useState<SubscriptionDialogTarget | null>(null);
  const [open, setOpen] = useState(false);
  const currentDialogSession = useMemo(
    () => ({ collectionItem: target?.collectionItem ?? null }),
    [target?.collectionItem],
  );
  const dialogSession = useDialogSessionSnapshot(open, target?.id ?? null, currentDialogSession);
  const { scheduleCleanup, cancelCleanup } = useDeferredDialogCleanup(() => setTarget(null));

  const show = useCallback((id: string) => {
    cancelCleanup();
    setTarget(createSubscriptionDialogTarget(subscriptions, id));
    setOpen(true);
  }, [cancelCleanup, subscriptions]);

  const onOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      cancelCleanup();
      return;
    }
    scheduleCleanup();
  }, [cancelCleanup, scheduleCleanup]);

  return {
    open,
    collectionItem: dialogSession.collectionItem,
    show,
    onOpenChange,
  };
}
