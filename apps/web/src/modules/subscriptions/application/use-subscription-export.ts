import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CostSharingCurrencyConverter } from "@renewlet/shared/cost-sharing";
import type { ApiBillingRecord } from "@renewlet/shared/schemas/billing-records";
import { toast } from "@/components/ui/sonner";
import type { Locale } from "@/i18n/locales";
import { localizedLabel } from "@/i18n/locales";
import { translate } from "@/i18n/messages";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { downloadFile } from "@/shared/browser/download-file";
import { listBillingRecords } from "@/services/billing-record-service";
import { exchangeRateSnapshotService } from "@/services/exchange-rate-snapshot-service";
import { listSubscriptionGroups } from "@/services/subscription-group-service";
import { subscriptionService } from "@/services/subscription-service";
import type { CustomConfig } from "@/types/config";
import type { AppSettings, Subscription } from "@/types/subscription";

/** 续订流水导出上限，与 shared IMPORT_BILLING_RECORDS_LIMIT 及两端备份包契约对齐。 */
const EXPORT_BILLING_RECORDS_LIMIT = 2000;

async function loadExchangeRateSnapshotsForExport(signal: AbortSignal) {
  try {
    return await exchangeRateSnapshotService.list({}, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    // 汇率快照是报表口径增强，不能因为读取失败阻断订阅/设置这份基础可恢复导出。
    console.warn("Failed to include exchange-rate snapshots in Renewo export:", error);
    return [];
  }
}

/** 分组只在 Docker 运行面可用；读取失败（如 Worker 面无此接口）降级为无分组导出，不阻断备份。 */
async function loadGroupsForExport(signal: AbortSignal) {
  try {
    return await listSubscriptionGroups(signal);
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn("Failed to include subscription groups in Renewo export:", error);
    return [];
  }
}

/**
 * 逐订阅翻页拉全量续订流水；接口只开放按订阅分页，这里在导出时串行收敛。
 * 任一订阅失败只丢该订阅的流水并告警，保证基础备份可用；总条数达到 2000 即停止。
 */
async function loadBillingRecordsForExport(subscriptions: readonly Subscription[], signal: AbortSignal): Promise<ApiBillingRecord[]> {
  const records: ApiBillingRecord[] = [];
  for (const subscription of subscriptions) {
    if (records.length >= EXPORT_BILLING_RECORDS_LIMIT) break;
    try {
      let cursor: string | null = null;
      do {
        const page = await listBillingRecords(subscription.id, { limit: 100, cursor, signal });
        records.push(...page.records);
        cursor = page.nextCursor;
      } while (cursor && records.length < EXPORT_BILLING_RECORDS_LIMIT);
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(`Failed to include billing records for subscription ${subscription.id} in Renewo export:`, error);
    }
  }
  return records.slice(0, EXPORT_BILLING_RECORDS_LIMIT);
}

type SelectSubscriptionsForExport = (subscriptions: readonly Subscription[]) => Subscription[];

/** 完整订阅只在用户显式导出时读取，列表轻量缓存不会被伪装成备份数据。 */
export function useSubscriptionExport(
  config: CustomConfig,
  settings: AppSettings,
  locale: Locale,
  selectSubscriptionsForExport: SelectSubscriptionsForExport,
  timeZone = "UTC",
  costSharingCurrencyConvert?: CostSharingCurrencyConverter | undefined,
) {
  const [exporting, setExporting] = useState(false);
  const exportAbortRef = useRef<AbortController | null>(null);
  const categoryLabelByValue = useMemo(
    () => new Map(config.categories.map((category) => [category.value, localizedLabel(category.labels, locale)])),
    [config.categories, locale],
  );
  const statusLabelByValue = useMemo(
    () => new Map(config.statuses.map((status) => [status.value, localizedLabel(status.labels, locale)])),
    [config.statuses, locale],
  );

  useEffect(() => () => exportAbortRef.current?.abort(), []);

  const runExport = useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (exportAbortRef.current) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExporting(true);
    try {
      await operation(controller.signal);
    } catch {
      if (!controller.signal.aborted) {
        toast.error(translate(locale, "subscriptions.exportFailed"));
      }
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
        setExporting(false);
      }
    }
  }, [locale]);

  const exportBackup = useCallback((includeSecrets: boolean) => {
    void runExport(async (signal) => {
      // 序列化模块和轻量读取互不依赖；显式导出时并行启动，避免代码拆分产生新的请求瀑布。
      const [exportModule, subscriptions, exchangeRateSnapshots, groups] = await Promise.all([
        import("@/modules/import-export/domain/renewlet-export"),
        subscriptionService.exportAll(signal),
        loadExchangeRateSnapshotsForExport(signal),
        loadGroupsForExport(signal),
      ]);
      // 流水依赖订阅列表逐订阅分页，放在第二轮读取；失败在 loader 内已降级为空数组。
      const billingRecords = await loadBillingRecordsForExport(subscriptions, signal);
      await exportModule.exportRenewletBackup({
        subscriptions,
        settings,
        customConfig: config,
        includeSecrets,
        exchangeRateSnapshots,
        groups,
        billingRecords,
      }, { signal });
    });
  }, [config, runExport, settings]);

  const exportToJSON = useCallback(() => {
    void exportBackup(false);
  }, [exportBackup]);

  const exportToJSONWithSecrets = useCallback(() => {
    void exportBackup(true);
  }, [exportBackup]);

  const exportToCSV = useCallback(() => {
    void runExport(async (signal) => {
      const [exportModule, subscriptions] = await Promise.all([
        import("../domain/subscription-export"),
        subscriptionService.exportAll(signal),
      ]);
      const csvSubscriptions = selectSubscriptionsForExport(subscriptions);
      const csvContent = exportModule.buildSubscriptionsCsv(csvSubscriptions, {
        categoryLabelByValue,
        statusLabelByValue,
        locale,
        today: todayDateOnlyInTimeZone(new Date(), timeZone),
        costSharingCalculation: { convert: costSharingCurrencyConvert },
      });
      downloadFile(new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" }), "subscriptions.csv");
    });
  }, [
    categoryLabelByValue,
    costSharingCurrencyConvert,
    locale,
    runExport,
    selectSubscriptionsForExport,
    statusLabelByValue,
    timeZone,
  ]);

  return { exportToJSON, exportToJSONWithSecrets, exportToCSV, exporting };
}
