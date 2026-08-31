/**
 * 订阅组管理弹窗。
 *
 * 架构位置：订阅列表页设置区的入口，提供组的 CRUD 管理。
 * 不承担订阅归组操作（归组在订阅编辑表单的「所属组」字段完成）。
 * 删除组不会级联删除组内订阅，仅解除 groupId 绑定。
 */
import { useEffect, useState } from "react";
import { FolderCog, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { useI18n } from "@/i18n/I18nProvider";
import {
  useCreateSubscriptionGroup,
  useDeleteSubscriptionGroup,
  useSubscriptionGroups,
  useUpdateSubscriptionGroup,
} from "@/hooks/use-subscription-groups";
import { toast } from "@/components/ui/sonner";
import { getDisplayErrorMessage } from "@/lib/display-error";
import type { SubscriptionGroup } from "@renewlet/shared/schemas/subscription-groups";

interface SubscriptionGroupManageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface GroupDraft {
  name: string;
  description: string;
}

const EMPTY_DRAFT: GroupDraft = { name: "", description: "" };

export function SubscriptionGroupManageDialog({ open, onOpenChange }: SubscriptionGroupManageDialogProps) {
  const { t } = useI18n();
  const groupsQuery = useSubscriptionGroups(open);
  const createMutation = useCreateSubscriptionGroup();
  const updateMutation = useUpdateSubscriptionGroup();
  const deleteMutation = useDeleteSubscriptionGroup();

  const [draft, setDraft] = useState<GroupDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<GroupDraft>(EMPTY_DRAFT);
  const [deletingGroup, setDeletingGroup] = useState<SubscriptionGroup | null>(null);

  // 关闭弹窗时重置所有编辑状态。
  useEffect(() => {
    if (!open) {
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      setEditingDraft(EMPTY_DRAFT);
      setDeletingGroup(null);
    }
  }, [open]);

  const groups = groupsQuery.groups;

  const handleCreate = () => {
    const name = draft.name.trim();
    if (!name) return;
    createMutation.mutate(
      { name, description: draft.description.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(t("subscriptions.grouped.createSuccess"));
          setDraft(EMPTY_DRAFT);
        },
        onError: (error) => toast.error(t("subscriptions.grouped.createFailed"), { description: getDisplayErrorMessage(error, t("error.generic")) }),
      },
    );
  };

  const handleStartEdit = (group: SubscriptionGroup) => {
    setEditingId(group.id);
    setEditingDraft({ name: group.name, description: group.description ?? "" });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingDraft(EMPTY_DRAFT);
  };

  const handleSaveEdit = (groupId: string) => {
    const name = editingDraft.name.trim();
    if (!name) return;
    updateMutation.mutate(
      { id: groupId, patch: { name, description: editingDraft.description.trim() || null } },
      {
        onSuccess: () => {
          toast.success(t("subscriptions.grouped.updateSuccess"));
          handleCancelEdit();
        },
        onError: (error) => toast.error(t("subscriptions.grouped.updateFailed"), { description: getDisplayErrorMessage(error, t("error.generic")) }),
      },
    );
  };

  const handleDeleteConfirm = () => {
    if (!deletingGroup) return;
    deleteMutation.mutate(deletingGroup.id, {
      onSuccess: () => {
        toast.success(t("subscriptions.grouped.deleteSuccess"));
        setDeletingGroup(null);
      },
      onError: (error) => toast.error(t("subscriptions.grouped.deleteFailed"), { description: getDisplayErrorMessage(error, t("error.generic")) }),
    });
  };

  const createBusy = createMutation.isPending;
  const editBusy = updateMutation.isPending;
  const deleteBusy = deleteMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissMode="explicit"
        layout="frame"
        className="h5-dialog-frame h5-subscription-dialog-panel border-border bg-card p-0 sm:max-w-lg"
      >
        <DialogHeader className="shrink-0 px-6 pb-3 pt-5 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <FolderCog className="h-5 w-5 text-primary" />
            {t("subscriptions.grouped.manageGroups")}
          </DialogTitle>
          <DialogDescription>{t("subscriptions.grouped.manageGroupsDescription")}</DialogDescription>
        </DialogHeader>

        <div className="h5-subscription-dialog-scroll grid content-start gap-4 overflow-y-auto px-6 pb-4">
          {/* 创建表单 */}
          <div className="grid gap-3 rounded-lg border border-border bg-secondary/40 p-4">
            <div className="grid gap-2">
              <Label htmlFor="group-create-name">{t("subscriptions.grouped.groupName")}</Label>
              <Input
                id="group-create-name"
                value={draft.name}
                onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                placeholder={t("subscriptions.grouped.groupNamePlaceholder")}
                className="border-border bg-secondary"
                maxLength={120}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="group-create-desc">{t("subscriptions.grouped.groupDescription")}</Label>
              <Textarea
                id="group-create-desc"
                value={draft.description}
                onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                placeholder={t("subscriptions.grouped.groupDescriptionPlaceholder")}
                className="min-h-16 border-border bg-secondary"
                maxLength={500}
              />
            </div>
            <Button
              type="button"
              onClick={handleCreate}
              disabled={!draft.name.trim() || createBusy}
              className="w-fit gap-2 bg-primary text-primary-foreground hover:bg-primary-glow"
            >
              <Plus className="h-4 w-4" />
              {t("subscriptions.grouped.createGroup")}
            </Button>
          </div>

          {/* 组列表 */}
          {groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("subscriptions.grouped.empty")}</p>
          ) : (
            <div className="grid gap-2">
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="rounded-lg border border-border bg-secondary/40 p-3"
                  data-testid={`group-row-${group.id}`}
                >
                  {editingId === group.id ? (
                    <div className="grid gap-2">
                      <Input
                        value={editingDraft.name}
                        onChange={(e) => setEditingDraft((prev) => ({ ...prev, name: e.target.value }))}
                        placeholder={t("subscriptions.grouped.groupNamePlaceholder")}
                        className="border-border bg-secondary"
                        maxLength={120}
                        autoFocus
                      />
                      <Textarea
                        value={editingDraft.description}
                        onChange={(e) => setEditingDraft((prev) => ({ ...prev, description: e.target.value }))}
                        placeholder={t("subscriptions.grouped.groupDescriptionPlaceholder")}
                        className="min-h-14 border-border bg-secondary"
                        maxLength={500}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleSaveEdit(group.id)}
                          disabled={!editingDraft.name.trim() || editBusy}
                          className="bg-primary text-primary-foreground hover:bg-primary-glow"
                        >
                          {editBusy ? t("common.saving") : t("common.save")}
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={handleCancelEdit} className="border-border">
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{group.name}</p>
                        {group.description ? (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{group.description}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => handleStartEdit(group)}
                          aria-label={t("common.edit")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeletingGroup(group)}
                          aria-label={t("common.delete")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>

      <AlertDialog open={deletingGroup !== null} onOpenChange={(open) => { if (!open) setDeletingGroup(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("subscriptions.grouped.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("subscriptions.grouped.deleteDescription", { name: deletingGroup?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDeleteConfirm();
              }}
              disabled={deleteBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBusy ? t("common.saving") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
