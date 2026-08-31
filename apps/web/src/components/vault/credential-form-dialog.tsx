/**
 * 账号库凭据新增/编辑弹窗。
 *
 * 架构位置：纯表单展示组件；draft 状态在打开时初始化，提交语义交由调用方
 * （账号库页 / 订阅详情「关联账号」区块）通过 onSubmit 上送，弹窗不感知 mutation 细节。
 *
 * 密码三态（编辑模式）：字段留空 = 保持不变；勾选清除 = 显式 null；输入新值 = 替换。
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/I18nProvider";
import type { VaultCredential, VaultCredentialCreateRequest, VaultCredentialUpdateRequest } from "@renewlet/shared/schemas/vault";

/** Radix Select 不接受空串 value；用哨兵表示「不关联订阅/组」。 */
const SUBSCRIPTION_NONE_VALUE = "__none__";
const GROUP_NONE_VALUE = "__none__";

export interface VaultSubscriptionOption {
  id: string;
  name: string;
}

export interface VaultGroupOption {
  id: string;
  name: string;
}

export interface VaultCredentialFormSubmitResult {
  create?: VaultCredentialCreateRequest;
  update?: VaultCredentialUpdateRequest;
}

export interface VaultCredentialFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入即为编辑模式；null 表示创建。 */
  credential: VaultCredential | null;
  /** 创建时预选的关联订阅（订阅详情入口使用）。 */
  defaultSubscriptionId?: string | null | undefined;
  subscriptions: VaultSubscriptionOption[];
  /** 可绑定的订阅组列表；组级共享账号与订阅级子账号互斥。 */
  groups?: VaultGroupOption[];
  submitting: boolean;
  onSubmit: (result: VaultCredentialFormSubmitResult) => void;
}

interface CredentialDraft {
  title: string;
  url: string;
  username: string;
  password: string;
  notes: string;
  subscriptionId: string;
  groupId: string;
  clearPassword: boolean;
}

function buildDraft(credential: VaultCredential | null, defaultSubscriptionId: string | null | undefined): CredentialDraft {
  return {
    title: credential?.title ?? "",
    url: credential?.url ?? "",
    username: credential?.username ?? "",
    password: "",
    notes: credential?.notes ?? "",
    subscriptionId: credential?.subscriptionId || defaultSubscriptionId || "",
    groupId: credential?.groupId ?? "",
    clearPassword: false,
  };
}

export function VaultCredentialFormDialog({
  open,
  onOpenChange,
  credential,
  defaultSubscriptionId,
  subscriptions,
  groups,
  submitting,
  onSubmit,
}: VaultCredentialFormDialogProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CredentialDraft>(() => buildDraft(credential, defaultSubscriptionId));

  // 打开瞬间重建草稿；关闭期间的状态不会泄漏到下一次打开。
  useEffect(() => {
    if (open) setDraft(buildDraft(credential, defaultSubscriptionId));
  }, [open, credential, defaultSubscriptionId]);

  const isEditMode = credential !== null;
  const canSubmit = draft.title.trim().length > 0 && !submitting;
  // 组选择器仅在存在可选组时渲染；与订阅选择互斥。
  const hasGroupOptions = !!groups && groups.length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const title = draft.title.trim();
    const url = draft.url.trim();
    const username = draft.username.trim();
    // 哨兵值归一为空串；空串即"不绑定"。
    const subscriptionValue = draft.subscriptionId === SUBSCRIPTION_NONE_VALUE ? "" : draft.subscriptionId;
    const groupValue = draft.groupId === GROUP_NONE_VALUE ? "" : draft.groupId;
    const notes = draft.notes;
    if (isEditMode) {
      const patch: VaultCredentialUpdateRequest = { title };
      if (url !== credential.url) patch.url = url;
      if (username !== credential.username) patch.username = username;
      if (notes !== credential.notes) patch.notes = notes;
      // 订阅与组互斥：改动任一方时，显式把另一方清空，避免服务端残留旧绑定。
      if (subscriptionValue !== credential.subscriptionId) {
        patch.subscriptionId = subscriptionValue === "" ? null : subscriptionValue;
        if (credential.groupId !== "") patch.groupId = null;
      }
      if (groupValue !== credential.groupId) {
        patch.groupId = groupValue === "" ? null : groupValue;
        if (credential.subscriptionId !== "") patch.subscriptionId = null;
      }
      if (draft.clearPassword) patch.password = null;
      else if (draft.password.length > 0) patch.password = draft.password;
      onSubmit({ update: patch });
    } else {
      const create: VaultCredentialCreateRequest = { title };
      if (url !== "") create.url = url;
      if (username !== "") create.username = username;
      if (draft.password.length > 0) create.password = draft.password;
      if (notes.trim() !== "") create.notes = notes;
      // 订阅与组互斥：优先订阅，否则组，都没有即独立账号。
      if (subscriptionValue !== "") create.subscriptionId = subscriptionValue;
      else if (groupValue !== "") create.groupId = groupValue;
      onSubmit({ create });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissMode="explicit"
        layout="frame"
        className="h5-dialog-frame h5-subscription-dialog-panel border-border bg-card p-0 sm:max-w-lg"
      >
        <DialogHeader className="shrink-0 px-6 pb-3 pt-5 pr-12">
          <DialogTitle>{isEditMode ? t("vault.form.editTitle") : t("vault.form.createTitle")}</DialogTitle>
          <DialogDescription>{t("vault.form.description")}</DialogDescription>
        </DialogHeader>

        <form
          className="h5-subscription-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="h5-subscription-dialog-scroll grid content-start gap-4 overflow-y-auto px-6 pb-4">
          <div className="grid gap-2">
            <Label htmlFor="vault-credential-title">{t("vault.form.titleLabel")}</Label>
            <Input
              id="vault-credential-title"
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder={t("vault.form.titlePlaceholder")}
              className="border-border bg-secondary"
              maxLength={120}
              required
              autoFocus
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="vault-credential-url">{t("vault.form.urlLabel")}</Label>
            <Input
              id="vault-credential-url"
              type="url"
              inputMode="url"
              value={draft.url}
              onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
              placeholder={t("vault.form.urlPlaceholder")}
              className="border-border bg-secondary"
              maxLength={2048}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="vault-credential-username">{t("vault.form.usernameLabel")}</Label>
            <Input
              id="vault-credential-username"
              value={draft.username}
              onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value }))}
              placeholder={t("vault.form.usernamePlaceholder")}
              className="border-border bg-secondary"
              maxLength={200}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="vault-credential-password">{t("vault.form.passwordLabel")}</Label>
            <Input
              id="vault-credential-password"
              type="password"
              value={draft.password}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({
                  ...current,
                  password: value,
                  clearPassword: value.length > 0 ? false : current.clearPassword,
                }));
              }}
              placeholder={isEditMode && credential.hasPassword ? t("vault.form.passwordEditPlaceholder") : t("vault.form.passwordPlaceholder")}
              className="border-border bg-secondary"
              maxLength={1024}
              autoComplete="new-password"
            />
            {isEditMode && credential.hasPassword ? (
              <label className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={draft.clearPassword}
                  onCheckedChange={(checked) => {
                    const clear = checked === true;
                    setDraft((current) => ({
                      ...current,
                      clearPassword: clear,
                      password: clear ? "" : current.password,
                    }));
                  }}
                  aria-label={t("vault.form.passwordClearHint")}
                />
                {t("vault.form.passwordClearHint")}
              </label>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="vault-credential-subscription">{t("vault.form.subscriptionLabel")}</Label>
            <Select
              value={draft.subscriptionId === "" ? SUBSCRIPTION_NONE_VALUE : draft.subscriptionId}
              onValueChange={(value) => {
                const next = value === SUBSCRIPTION_NONE_VALUE ? "" : value;
                // 互斥：选择订阅时清空组绑定。
                setDraft((current) => ({
                  ...current,
                  subscriptionId: next,
                  groupId: next !== "" ? "" : current.groupId,
                }));
              }}
              disabled={draft.groupId !== ""}
            >
              <SelectTrigger id="vault-credential-subscription" className="border-border bg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SUBSCRIPTION_NONE_VALUE}>{t("vault.form.subscriptionNone")}</SelectItem>
                {subscriptions.map((subscription) => (
                  <SelectItem key={subscription.id} value={subscription.id}>
                    {subscription.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {hasGroupOptions ? (
            <div className="grid gap-2">
              <Label htmlFor="vault-credential-group">{t("vault.form.groupLabel")}</Label>
              <Select
                value={draft.groupId === "" ? GROUP_NONE_VALUE : draft.groupId}
                onValueChange={(value) => {
                  const next = value === GROUP_NONE_VALUE ? "" : value;
                  // 互斥：选择组时清空订阅绑定。
                  setDraft((current) => ({
                    ...current,
                    groupId: next,
                    subscriptionId: next !== "" ? "" : current.subscriptionId,
                  }));
                }}
                disabled={draft.subscriptionId !== ""}
              >
                <SelectTrigger id="vault-credential-group" className="border-border bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GROUP_NONE_VALUE}>{t("vault.form.groupNone")}</SelectItem>
                  {groups!.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("vault.form.groupHelp")}</p>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="vault-credential-notes">{t("vault.form.notesLabel")}</Label>
            <Textarea
              id="vault-credential-notes"
              value={draft.notes}
              onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              placeholder={t("vault.form.notesPlaceholder")}
              className="min-h-20 border-border bg-secondary"
              maxLength={5000}
            />
          </div>
          </div>

          <DialogFooter className="shrink-0 border-t border-border px-6 pb-5 pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="bg-primary text-primary-foreground hover:bg-primary-glow"
            >
              {submitting ? t("common.saving") : isEditMode ? t("vault.form.submitUpdate") : t("vault.form.submitCreate")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
