/**
 * 账号库页（/vault）。
 *
 * 功能：
 * - 集中管理订阅服务的账号凭据（新增/编辑/删除/复制/查看密码）
 * - 按关联订阅分组展示，支持独立账号与搜索过滤
 *
 * 架构位置：
 * - 数据面统一走 use-vault hooks；reveal 明文只停留在卡片组件内。
 * - 关联订阅名来自订阅 index 缓存，不在 vault 模块里保存第二份订阅数据。
 */

import { useEffect, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Header } from "@/components/header";
import { QueryErrorState } from "@/components/query-error-state";
import { VaultPageSkeleton } from "@/components/loading-skeleton";
import { VaultCredentialCard } from "@/components/vault/credential-card";
import {
  VaultCredentialFormDialog,
  type VaultCredentialFormSubmitResult,
  type VaultSubscriptionOption,
} from "@/components/vault/credential-form-dialog";
import { AccessCodesSection, CreateCodeDialog } from "@/components/vault/access-codes-section";
import { AccessRequestsSection } from "@/components/vault/access-requests-section";
import { AccessLogsSection } from "@/components/vault/access-logs-section";
import { PlainCodeRevealDialog } from "@/components/vault/plain-code-reveal-dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useI18n } from "@/i18n/I18nProvider";
import {
  useCreateVaultCredential,
  useDeleteVaultCredential,
  useUpdateVaultCredential,
  useVaultCredentials,
} from "@/hooks/use-vault";
import { useCreateVaultAccessCode } from "@/hooks/use-vault-p2";
import { useSubscriptionIndex } from "@/hooks/use-subscriptions";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { getDisplayErrorMessage } from "@/lib/display-error";
import type { VaultCredential } from "@renewlet/shared/schemas/vault";

type VaultTab = "credentials" | "accessCodes" | "requests" | "auditLogs";
type VaultScopeFilter = "all" | "linked" | "standalone";

const SCOPE_FILTERS: VaultScopeFilter[] = ["all", "linked", "standalone"];
const TAB_VALUES: VaultTab[] = ["credentials", "accessCodes", "requests", "auditLogs"];

function credentialMatchesQuery(credential: VaultCredential, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    credential.title.toLowerCase().includes(needle)
    || credential.username.toLowerCase().includes(needle)
    || credential.url.toLowerCase().includes(needle)
  );
}

export default function Vault() {
  const { t } = useI18n();
  const credentialsQuery = useVaultCredentials();
  const subscriptionsQuery = useSubscriptionIndex();
  const createMutation = useCreateVaultCredential();
  const updateMutation = useUpdateVaultCredential();
  const deleteMutation = useDeleteVaultCredential();
  const createCodeMutation = useCreateVaultAccessCode();

  const [activeTab, setActiveTab] = useState<VaultTab>("credentials");
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<VaultScopeFilter>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingCredential, setEditingCredential] = useState<VaultCredential | null>(null);
  const [deletingCredential, setDeletingCredential] = useState<VaultCredential | null>(null);
  const [codeTarget, setCodeTarget] = useState<VaultCredential | null>(null);
  const [revealedPlainCode, setRevealedPlainCode] = useState<string | null>(null);

  const credentials = useMemo(() => credentialsQuery.data ?? [], [credentialsQuery.data]);
  const subscriptionNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of subscriptionsQuery.data?.subscriptions ?? []) {
      map.set(item.id, item.name);
    }
    return map;
  }, [subscriptionsQuery.data?.subscriptions]);
  const subscriptionOptions = useMemo<VaultSubscriptionOption[]>(
    () => (subscriptionsQuery.data?.subscriptions ?? []).map((item) => ({ id: item.id, name: item.name })),
    [subscriptionsQuery.data?.subscriptions],
  );

  const visibleCredentials = useMemo(
    () => credentials.filter((credential) => {
      if (scopeFilter === "linked" && credential.subscriptionId === "") return false;
      if (scopeFilter === "standalone" && credential.subscriptionId !== "") return false;
      return credentialMatchesQuery(credential, searchQuery);
    }),
    [credentials, scopeFilter, searchQuery],
  );

  // 关联订阅分组（组名按订阅名排序）；独立账号单独成组置底。
  const linkedGroups = useMemo(() => {
    const groups = new Map<string, VaultCredential[]>();
    for (const credential of visibleCredentials) {
      if (credential.subscriptionId === "") continue;
      const bucket = groups.get(credential.subscriptionId);
      if (bucket) bucket.push(credential);
      else groups.set(credential.subscriptionId, [credential]);
    }
    return [...groups.entries()]
      .map(([subscriptionId, items]) => ({
        key: subscriptionId,
        name: subscriptionNameById.get(subscriptionId) ?? subscriptionId,
        items,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [visibleCredentials, subscriptionNameById]);
  const standaloneCredentials = useMemo(
    () => visibleCredentials.filter((credential) => credential.subscriptionId === ""),
    [visibleCredentials],
  );

  useEffect(() => {
    if (!credentialsQuery.error) return;
    toast.error(t("vault.loadFailed"), { description: getDisplayErrorMessage(credentialsQuery.error, t("error.generic")) });
  }, [credentialsQuery.error, t]);

  const openCreate = () => {
    setEditingCredential(null);
    setFormOpen(true);
  };

  const openEdit = (credential: VaultCredential) => {
    setEditingCredential(credential);
    setFormOpen(true);
  };

  const submitting = createMutation.isPending || updateMutation.isPending;

  const handleFormSubmit = (result: VaultCredentialFormSubmitResult) => {
    if (result.create) {
      createMutation.mutate(result.create, {
        onSuccess: () => {
          toast.success(t("vault.create.success"));
          setFormOpen(false);
        },
        onError: (error) => toast.error(t("vault.create.failed"), { description: getDisplayErrorMessage(error, t("error.generic")) }),
      });
    } else if (result.update && editingCredential) {
      updateMutation.mutate(
        { credentialId: editingCredential.id, patch: result.update },
        {
          onSuccess: () => {
            toast.success(t("vault.update.success"));
            setFormOpen(false);
          },
          onError: (error) => toast.error(t("vault.update.failed"), { description: getDisplayErrorMessage(error, t("error.generic")) }),
        },
      );
    }
  };

  const handleDeleteConfirm = () => {
    if (!deletingCredential) return;
    deleteMutation.mutate(deletingCredential.id, {
      onSuccess: () => {
        toast.success(t("vault.delete.success"));
        setDeletingCredential(null);
      },
      onError: (error) => toast.error(t("vault.delete.failed"), { description: getDisplayErrorMessage(error, t("error.generic")) }),
    });
  };

  if (credentialsQuery.isPending) {
    return (
      <div className="app-page bg-background">
        <Header />
        <main className="app-main mx-auto max-w-7xl">
          <VaultPageSkeleton withPageShell={false} />
        </main>
      </div>
    );
  }

  if (credentialsQuery.error) {
    return (
      <div className="app-page bg-background">
        <Header />
        <main className="app-main mx-auto max-w-7xl">
          <QueryErrorState error={credentialsQuery.error} onRetry={() => void credentialsQuery.refetch()} />
        </main>
      </div>
    );
  }

  const renderGroup = (name: string, items: VaultCredential[], testId: string) => (
    <section className="mb-8" data-testid={testId}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">{name}</h2>
        <span className="text-xs text-muted-foreground">{t("vault.count", { count: items.length })}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((credential) => (
          <VaultCredentialCard
            key={credential.id}
            credential={credential}
            subscriptionName={credential.subscriptionId === "" ? null : subscriptionNameById.get(credential.subscriptionId) ?? null}
            onEdit={openEdit}
            onDelete={setDeletingCredential}
            onGenerateCode={setCodeTarget}
          />
        ))}
      </div>
    </section>
  );

  return (
    <div className="app-page bg-background">
      <Header />

      <main className="app-main mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{t("vault.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("vault.description")}</p>
          </div>
          {activeTab === "credentials" ? (
            <Button onClick={openCreate} className="w-full gap-2 sm:w-auto" data-testid="vault-add-button">
              <Plus className="h-4 w-4" />
              {t("vault.addCredential")}
            </Button>
          ) : null}
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as VaultTab)}
          className="w-full"
        >
          <TabsList className="mb-6 h-auto w-full flex-wrap justify-start gap-1 rounded-lg border border-border bg-secondary/60 p-1">
            {TAB_VALUES.map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className={cn(
                  "px-4 py-2",
                  activeTab === tab ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`vault.tab.${tab}`)}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="credentials">
            <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("vault.searchPlaceholder")}
                  className="border-border bg-secondary pl-9"
                  aria-label={t("vault.searchPlaceholder")}
                />
              </div>
              <div className="flex w-fit items-center gap-1 rounded-lg border border-border bg-secondary/60 p-1" role="group" aria-label={t("vault.title")}>
                {SCOPE_FILTERS.map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setScopeFilter(scope)}
                    aria-pressed={scopeFilter === scope}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                      scopeFilter === scope
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`vault.filter.${scope}`)}
                  </button>
                ))}
              </div>
            </div>

            {visibleCredentials.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center" data-testid="vault-empty-state">
                <h2 className="text-lg font-semibold text-foreground">
                  {credentials.length === 0 ? t("vault.empty.title") : t("vault.empty.search")}
                </h2>
                {credentials.length === 0 ? (
                  <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{t("vault.empty.description")}</p>
                ) : null}
              </div>
            ) : (
              <>
                {linkedGroups.map((group) => renderGroup(group.name, group.items, `vault-group-${group.key}`))}
                {standaloneCredentials.length > 0
                  ? renderGroup(t("vault.group.standalone"), standaloneCredentials, "vault-group-standalone")
                  : null}
              </>
            )}
          </TabsContent>

          <TabsContent value="accessCodes">
            <AccessCodesSection subscriptions={subscriptionOptions} />
          </TabsContent>

          <TabsContent value="requests">
            <AccessRequestsSection subscriptions={subscriptionOptions} credentials={credentials} />
          </TabsContent>

          <TabsContent value="auditLogs">
            <AccessLogsSection />
          </TabsContent>
        </Tabs>
      </main>

      <VaultCredentialFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        credential={editingCredential}
        subscriptions={subscriptionOptions}
        submitting={submitting}
        onSubmit={handleFormSubmit}
      />

      {/* 条件渲染：每次打开都重新挂载，确保锁定的账号始终是当前点击的卡片账号 */}
      {codeTarget ? (
        <CreateCodeDialog
          open
          onOpenChange={(open) => { if (!open) setCodeTarget(null); }}
          credentials={credentials}
          submitting={createCodeMutation.isPending}
          lockedCredentialId={codeTarget.id}
          onSubmit={async (body) => {
            const created = await createCodeMutation.mutateAsync(body);
            toast.success(t("vault.codes.create.success"));
            setCodeTarget(null);
            setRevealedPlainCode(created.plainCode);
          }}
          onError={(err) => toast.error(getDisplayErrorMessage(err, t("vault.codes.create.failed")))}
        />
      ) : null}

      <PlainCodeRevealDialog
        open={revealedPlainCode !== null}
        plainCode={revealedPlainCode ?? ""}
        onClose={() => setRevealedPlainCode(null)}
      />

      <AlertDialog open={deletingCredential !== null} onOpenChange={(open) => { if (!open) setDeletingCredential(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("vault.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("vault.delete.description", { title: deletingCredential?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                handleDeleteConfirm();
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? t("common.saving") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
