import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, Filter, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VirtualizedList } from "@/components/ui/virtualized-list";
import { ImportLogoEditor, type DeferredLogoAsset } from "@/components/import-logo-editor";
import { SubscriptionLogo } from "@/components/subscription-logo";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/messages";
import type { ImportConflictMode, ImportItemAction, ImportPreviewItem, ImportPreviewResponse, ImportSummary } from "@/lib/api/schemas/import-export";
import { formatImportMessage } from "@/modules/import-export/domain/import-message-format";
import { loadImportAssetBlob } from "@/modules/import-export/domain/wallos-import";
import type { PreparedImport } from "@/modules/import-export/domain/import-export-model";
import { formatBillingCycleLabel } from "@/lib/subscription-billing";
import { cn } from "@/lib/utils";

export type PreviewFilter = "all" | "create" | "replace" | "skip" | "warning" | "error";

const PREVIEW_FILTERS = ["all", "create", "replace", "skip", "warning", "error"] as const satisfies readonly PreviewFilter[];

const IMPORT_ACTION_LABEL_KEYS: Record<ImportItemAction, MessageKey> = {
  create: "import.action.create",
  replace: "import.action.replace",
  skip: "import.action.skip",
  error: "import.action.error",
};

const PREVIEW_FILTER_LABEL_KEYS: Record<PreviewFilter, MessageKey> = {
  all: "import.filter.all",
  create: "import.filter.create",
  replace: "import.filter.replace",
  skip: "import.filter.skip",
  warning: "import.filter.warning",
  error: "import.filter.error",
};

interface ImportPreviewListProps {
  /** 解析后的导入载荷与暂存资产；Logo 编辑只更新这份前端暂存态，真正持久化发生在 apply 阶段。 */
  prepared: PreparedImport;
  /** 服务端预览结果是冲突/错误的事实来源，前端只允许叠加筛选和手动覆盖。 */
  preview: ImportPreviewResponse;
  filter: PreviewFilter;
  /** 当前冲突策略，决定 existing 行的默认动作，也参与单按钮状态机。 */
  conflictMode: ImportConflictMode;
  /** 手动跳过以原始导入 index 标识，避免虚拟列表筛选后行号变化误作用到其他订阅。 */
  skippedIndexes: ReadonlySet<number>;
  /** skip 模式下逐条强制替换；与 skippedIndexes 互斥，UI 层保证。 */
  forceReplaceIndexes: ReadonlySet<number>;
  onFilterChange: (filter: PreviewFilter) => void;
  onLogoChange: (index: number, value: string | null, asset?: DeferredLogoAsset) => void;
  /** 单按钮在 跳过/恢复/强制替换 之间切换该行的生效动作。 */
  onToggleRow: (index: number) => void;
}

export function ImportPreviewList({
  prepared,
  preview,
  filter,
  conflictMode,
  skippedIndexes,
  forceReplaceIndexes,
  onFilterChange,
  onLogoChange,
  onToggleRow,
}: ImportPreviewListProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const filteredItems = useMemo(() => filterPreviewItems(preview.items, filter), [filter, preview.items]);
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback((index: number) => {
    const item = filteredItems[index];
    return item ? `${item.source}:${item.sourceId}:${item.index}` : index;
  }, [filteredItems]);
  const renderItem = useCallback((index: number) => {
    const item = filteredItems[index];
    if (!item) return null;
    return (
      <PreviewRow
        item={item}
        prepared={prepared}
        conflictMode={conflictMode}
        manualSkipped={skippedIndexes.has(item.index)}
        forcedReplace={forceReplaceIndexes.has(item.index)}
        actionLabel={t(IMPORT_ACTION_LABEL_KEYS[item.action])}
        onLogoChange={onLogoChange}
        onToggleRow={onToggleRow}
      />
    );
  }, [conflictMode, filteredItems, forceReplaceIndexes, onLogoChange, onToggleRow, prepared, skippedIndexes, t]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/20 p-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        {PREVIEW_FILTERS.map((nextFilter) => (
          <button
            key={nextFilter}
            type="button"
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              filter === nextFilter ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
            onClick={() => onFilterChange(nextFilter)}
          >
            {t(PREVIEW_FILTER_LABEL_KEYS[nextFilter])}
          </button>
        ))}
      </div>
      <div ref={scrollRef} className="h-80 overflow-y-auto rounded-lg border border-border bg-background">
        {filteredItems.length > 0 ? (
          <VirtualizedList
            count={filteredItems.length}
            estimatedItemSize={126}
            getItemKey={getItemKey}
            getScrollElement={getScrollElement}
            overscan={8}
            renderItem={renderItem}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("import.previewFilterEmpty")}
          </div>
        )}
      </div>
    </>
  );
}

export function recomputePreviewForConflictMode(
  preview: ImportPreviewResponse,
  conflictMode: ImportConflictMode,
  skippedIndexes: ReadonlySet<number> = new Set<number>(),
  forceReplaceIndexes: ReadonlySet<number> = new Set<number>(),
): ImportPreviewResponse {
  // 覆盖优先级：手动 skip（用户显式操作，最高）→ force replace（skip 模式覆盖冲突）→ error → conflictMode → create。
  const items = preview.items.map((item) => {
    if (skippedIndexes.has(item.index)) return { ...item, action: "skip" as const };
    if (item.errors.length > 0 || item.action === "error") return { ...item, action: "error" as const };
    if (item.existingId) {
      if (forceReplaceIndexes.has(item.index)) return { ...item, action: "replace" as const };
      return { ...item, action: conflictMode === "replace" ? "replace" as const : "skip" as const };
    }
    return { ...item, action: "create" as const };
  });
  return { ...preview, items, summary: summarizePreviewItems(items) };
}

function PreviewRow({
  item,
  prepared,
  conflictMode,
  manualSkipped,
  forcedReplace,
  actionLabel,
  onLogoChange,
  onToggleRow,
}: {
  item: ImportPreviewItem;
  prepared: PreparedImport;
  conflictMode: ImportConflictMode;
  manualSkipped: boolean;
  forcedReplace: boolean;
  actionLabel: string;
  onLogoChange: (index: number, value: string | null, asset?: DeferredLogoAsset) => void;
  onToggleRow: (index: number) => void;
}) {
  const { t, locale } = useI18n();
  const subscription = prepared.payload.subscriptions[item.index];
  const logoAutoMatch = prepared.logoAutoMatches?.find((match) => match.subscriptionIndex === item.index && match.url === subscription?.logo);
  const messages = [...item.warnings, ...item.errors];
  const localizedMessages = messages.map((message) => ({ raw: message, text: formatImportMessage(message, t) }));
  const billingCycle = subscription
    ? {
        billingCycle: subscription.billingCycle,
        customDays: subscription.customDays ?? undefined,
        customCycleUnit: subscription.customCycleUnit ?? undefined,
      }
    : null;
  // 单按钮语义：当前生效动作是"跳过"（手动跳过，或 skip 模式下无错误 existing 行的默认跳过）时显示"恢复导入"，
  // 点击恢复（skip 模式 existing 行转为强制替换）；错误行只能手动跳过，其余情况显示"跳过此条"。
  const showRestore = manualSkipped
    || (Boolean(item.existingId) && conflictMode === "skip" && !forcedReplace && item.errors.length === 0);
  const rowOverridden = manualSkipped || forcedReplace;
  return (
    <div className={cn("border-b border-border p-3 last:border-b-0", rowOverridden && "bg-secondary/20")}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <ImportPreviewLogo prepared={prepared} index={item.index} name={item.name} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="min-w-0 truncate text-sm font-medium text-foreground">{item.name}</p>
              <Badge variant={item.action === "error" ? "destructive" : item.action === "replace" ? "outline" : "secondary"}>
                {actionLabel}
              </Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{item.source}:{item.sourceId}</p>
            {subscription ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="bg-secondary/40 text-[11px] font-medium text-muted-foreground">
                  {subscription.currency}
                </Badge>
                <Badge
                  variant={subscription.billingCycle === "one-time" ? "secondary" : "outline"}
                  className="bg-secondary/40 text-[11px] font-medium text-muted-foreground"
                >
                  {billingCycle ? formatBillingCycleLabel(billingCycle, locale) : null}
                </Badge>
                {logoAutoMatch ? (
                  <Badge variant="outline" className="bg-primary/10 text-[11px] font-medium text-primary" data-testid={`import-logo-auto-match-${item.index}`}>
                    {t("import.logoAutoMatched")}
                  </Badge>
                ) : null}
              </div>
            ) : null}
            {localizedMessages.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {localizedMessages.slice(0, 3).map((message, messageIndex) => (
                  <li key={`${message.raw}:${messageIndex}`} className="flex gap-1.5">
                    <AlertTriangle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", item.errors.includes(message.raw) ? "text-destructive" : "text-muted-foreground")} />
                    <span>{message.text}</span>
                  </li>
                ))}
                {localizedMessages.length > 3 ? <li className="pl-5">{`+${localizedMessages.length - 3}`}</li> : null}
              </ul>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 sm:flex-col sm:items-end">
          <Button
            type="button"
            variant={rowOverridden ? "secondary" : "outline"}
            size="sm"
            className="h-9"
            onClick={() => onToggleRow(item.index)}
          >
            {showRestore ? <RotateCcw className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
            {showRestore ? t("import.restoreItem") : t("import.skipItem")}
          </Button>
          {subscription ? (
            <ImportLogoEditor
              name={subscription.name}
              website={subscription.website}
              value={subscription.logo}
              assetPreviewUrl={prepared.assets.find((asset) => asset.target.type === "subscriptionLogo" && asset.target.subscriptionIndex === item.index)?.previewUrl}
              onChange={(value, asset) => onLogoChange(item.index, value, asset)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ImportPreviewLogo({ prepared, index, name }: { prepared: PreparedImport; index: number; name: string }) {
  const subscription = prepared.payload.subscriptions[index];
  const asset = prepared.assets.find((item) => item.target.type === "subscriptionLogo" && item.target.subscriptionIndex === index);
  const [assetPreviewUrl, setAssetPreviewUrl] = useState<string | undefined>();
  const src = asset?.previewUrl ?? subscription?.logo ?? assetPreviewUrl;

  useEffect(() => {
    if (!asset || asset.previewUrl || subscription?.logo) return;
    let revokedUrl: string | null = null;
    let cancelled = false;
    // ZIP/SQLite 导入资产按需解包成 object URL；虚拟列表会频繁卸载行，清理逻辑必须同时处理未完成的异步读取和已创建 URL。
    void loadImportAssetBlob(asset).then((blob) => {
      if (cancelled) return;
      revokedUrl = URL.createObjectURL(blob);
      setAssetPreviewUrl(revokedUrl);
    }).catch(() => setAssetPreviewUrl(undefined));
    return () => {
      cancelled = true;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [asset, subscription?.logo]);

  return (
    <SubscriptionLogo name={name} logo={src} size="sm" className="h-11 w-11" />
  );
}

function filterPreviewItems(items: ImportPreviewItem[], filter: PreviewFilter): ImportPreviewItem[] {
  if (filter === "all") return items;
  if (filter === "warning") return items.filter((item) => item.warnings.length > 0);
  if (filter === "error") return items.filter((item) => item.action === "error");
  return items.filter((item) => item.action === filter);
}

function summarizePreviewItems(items: ImportPreviewItem[]): ImportSummary {
  return items.reduce<ImportSummary>((summary, item) => ({
    total: summary.total + 1,
    creates: summary.creates + (item.action === "create" ? 1 : 0),
    replaces: summary.replaces + (item.action === "replace" ? 1 : 0),
    skips: summary.skips + (item.action === "skip" ? 1 : 0),
    errors: summary.errors + (item.action === "error" ? 1 : 0),
    warnings: summary.warnings + item.warnings.length,
  }), { total: 0, creates: 0, replaces: 0, skips: 0, errors: 0, warnings: 0 });
}
