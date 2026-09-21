import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { AlertTriangle, Archive, CheckCircle2, FileJson, FileUp, KeyRound, Loader2 } from "lucide-react";
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
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ImportFileDropZone, ImportPastePanel, ImportStep } from "@/components/import-data-dialog-parts";
import { ImportPreviewPanel } from "@/components/import-preview-panel";
import { useDeferredDialogInitialFocus } from "@/hooks/use-deferred-dialog-initial-focus";
import { useI18n } from "@/i18n/I18nProvider";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import type { CustomConfig } from "@/types/config";
import type { AppSettings } from "@/types/subscription";
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_PREVIEW_SUBSCRIPTIONS,
  type WallosImportUser,
} from "@/modules/import-export/domain/import-export-model";
import {
  parseImportFile,
  parseJsonText,
} from "@/modules/import-export/domain/wallos-import";
import { formatImportMessage } from "@/modules/import-export/domain/import-message-format";
import { useImportPreviewApply } from "@/modules/import-export/application/use-import-preview-apply";
import { verifyImportVaultPassphrase } from "@/services/vault-service";

export interface ImportDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入解析使用当前设置里的 timezone/defaultCurrency/reminder 默认值，不自行读取全局 query。 */
  settings: AppSettings;
  /** Wallos/Renewo 导入会映射分类、状态、支付方式和货币，必须使用当前已规范化配置。 */
  config: CustomConfig;
  /** 外部恢复入口预载的文件；仍然只进入 preview/apply，不在弹窗外写库。 */
  initialFile?: File | null;
  /** 云快照外层 ZIP 已通过后端 hash 校验，可使用独立于普通导入的 16 MiB 存储包上限。 */
  initialFileMaxBytes?: number;
  onInitialFileConsumed?: () => void;
}

export function ImportDataDialogContent({ open, onOpenChange, settings, config, initialFile, initialFileMaxBytes, onInitialFileConsumed }: ImportDataDialogProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const consumedInitialFileRef = useRef<File | null>(null);
  const parseAbortRef = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [pasteValue, setPasteValue] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [wallosUsers, setWallosUsers] = useState<WallosImportUser[]>([]);
  const [selectedWallosUser, setSelectedWallosUser] = useState<string>("");
  const [parsing, setParsing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const today = todayDateOnlyInTimeZone(new Date(), settings.timezone);
  const importPreview = useImportPreviewApply({ onApplied: () => onOpenChange(false) });
  const resolveInitialFocus = useCallback(() => uploadButtonRef.current, []);
  const {
    prepared,
    preview,
    conflictMode,
    previewFilter,
    skippedIndexes,
    forceReplaceIndexes,
    error,
    applying,
    assetProgress,
    applyProgress,
    backupPassphrase,
    setBackupPassphrase,
    setError,
    setPreviewFilter,
    resetImportPreview,
    previewPrepared,
    handleConflictModeChange,
    handleLogoChange,
    handleToggleRow,
    handleApply,
  } = importPreview;
  // Renewo 自导出包中的账号库凭据段：存在时允许留空备份密码跳过凭据恢复。
  const vaultCredentialsCount = prepared?.payload.vaultCredentials?.length ?? 0;
  // 预检用样本密文：任一字段非空即可验证 KEK 是否正确。
  const vaultProbeCredential = prepared?.payload.vaultCredentials?.find(
    (item) => item.passwordBackup || item.notesBackup,
  );
  const vaultProbeCiphertext = vaultProbeCredential?.passwordBackup || vaultProbeCredential?.notesBackup || "";
  // empty = 未输入密码；invalid = 密码预检失败。二次确认后跳过凭据执行其余导入。
  const [vaultConfirmReason, setVaultConfirmReason] = useState<"empty" | "invalid" | null>(null);
  const [verifyingPassphrase, setVerifyingPassphrase] = useState(false);
  useDeferredDialogInitialFocus(open, true, "import", resolveInitialFocus);

  // 点击执行导入：含凭据段时先做密码预检——留空或密码错误都先弹二次确认，
  // 用户可选择跳过凭据继续导入，或返回修改密码；预检不写任何业务数据。
  const handleExecuteClick = useCallback(async () => {
    if (vaultCredentialsCount === 0) {
      void handleApply();
      return;
    }
    if (backupPassphrase.trim().length === 0) {
      setVaultConfirmReason("empty");
      return;
    }
    const envelope = prepared?.payload.backupEnvelope;
    if (!envelope || !vaultProbeCiphertext) {
      // 包结构缺少 envelope/密文样本时无法预检，交给 apply 按契约处理。
      void handleApply();
      return;
    }
    setVerifyingPassphrase(true);
    try {
      const valid = await verifyImportVaultPassphrase(envelope, vaultProbeCiphertext, backupPassphrase);
      if (valid) {
        void handleApply();
      } else {
        setVaultConfirmReason("invalid");
      }
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : t("import.vaultVerifyFailed"));
    } finally {
      setVerifyingPassphrase(false);
    }
  }, [backupPassphrase, handleApply, prepared, setError, t, vaultCredentialsCount, vaultProbeCiphertext]);

  const parseFile = useCallback(async (
    nextFile: File,
    options: {
      maxFileBytes: number;
      signal: AbortSignal;
      wallosUserId?: string;
    },
  ) => {
    const { maxFileBytes, signal, wallosUserId } = options;
    if (nextFile.size > maxFileBytes) {
      throw new Error(t("import.fileTooLarge"));
    }
    // 文件类型只做入口提示，真实识别按内容探测；zip/db 解析器只在导入弹窗内动态加载。
    const parsed = await parseImportFile(nextFile, { config, settings, today }, wallosUserId, maxFileBytes, signal);
    if (parsed.payload.subscriptions.length > MAX_IMPORT_PREVIEW_SUBSCRIPTIONS) {
      throw new Error(t("import.fileTooLarge"));
    }
    setWallosUsers(parsed.wallosUsers ?? []);
    if (parsed.wallosUsers?.length && !wallosUserId) {
      setSelectedWallosUser(parsed.wallosUsers[0]?.id ?? "");
    }
    await previewPrepared(parsed, conflictMode, signal);
  }, [config, conflictMode, previewPrepared, settings, t, today]);

  const handleFileSelected = useCallback(async (nextFile: File | null, maxFileBytes = MAX_IMPORT_FILE_BYTES) => {
    if (!nextFile) return;
    // 文件对象只保存在弹窗生命周期内；预览失败时清掉 PreparedImport，避免应用上一次成功解析的包。
    setFile(nextFile);
    parseAbortRef.current?.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setParsing(true);
    setError(null);
    try {
      await parseFile(nextFile, {
        maxFileBytes,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      resetImportPreview();
      setError(err instanceof Error ? formatImportMessage(err.message, t) : t("import.parseFailed"));
    } finally {
      if (parseAbortRef.current === controller) {
        parseAbortRef.current = null;
        setParsing(false);
      }
    }
  }, [parseFile, resetImportPreview, setError, t]);

  const handleFileDrop = async (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragActive(false);
    await handleFileSelected(event.dataTransfer.files?.[0] ?? null);
  };

  const handlePastePreview = async () => {
    parseAbortRef.current?.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setFile(null);
    setParsing(true);
    setError(null);
    try {
      if (new TextEncoder().encode(pasteValue).byteLength > MAX_IMPORT_FILE_BYTES) {
        throw new Error(t("import.fileTooLarge"));
      }
      const parsed = await parseJsonText(pasteValue, { config, settings, today });
      if (parsed.payload.subscriptions.length > MAX_IMPORT_PREVIEW_SUBSCRIPTIONS) {
        throw new Error(t("import.fileTooLarge"));
      }
      controller.signal.throwIfAborted();
      setWallosUsers(parsed.wallosUsers ?? []);
      if (parsed.wallosUsers?.length) {
        setSelectedWallosUser(parsed.wallosUsers[0]?.id ?? "");
      }
      await previewPrepared(parsed, conflictMode, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      resetImportPreview();
      setError(err instanceof Error ? formatImportMessage(err.message, t) : t("import.parseFailed"));
    } finally {
      if (parseAbortRef.current === controller) {
        parseAbortRef.current = null;
        setParsing(false);
      }
    }
  };

  const handleWallosUserChange = async (value: string) => {
    setSelectedWallosUser(value);
    parseAbortRef.current?.abort();
    const controller = new AbortController();
    parseAbortRef.current = controller;
    setParsing(true);
    setError(null);
    try {
      if (file) {
        await parseFile(file, {
          maxFileBytes: MAX_IMPORT_FILE_BYTES,
          signal: controller.signal,
          wallosUserId: value,
        });
      } else if (pasteValue.trim()) {
        if (new TextEncoder().encode(pasteValue).byteLength > MAX_IMPORT_FILE_BYTES) {
          throw new Error(t("import.fileTooLarge"));
        }
        const parsed = await parseJsonText(pasteValue, { config, settings, today }, value);
        if (parsed.payload.subscriptions.length > MAX_IMPORT_PREVIEW_SUBSCRIPTIONS) {
          throw new Error(t("import.fileTooLarge"));
        }
        await previewPrepared(parsed, conflictMode, controller.signal);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? formatImportMessage(err.message, t) : t("import.parseFailed"));
    } finally {
      if (parseAbortRef.current === controller) {
        parseAbortRef.current = null;
        setParsing(false);
      }
    }
  };

  useEffect(() => {
    if (!open || !initialFile || consumedInitialFileRef.current === initialFile) return;
    consumedInitialFileRef.current = initialFile;
    setMode("file");
    void handleFileSelected(initialFile, initialFileMaxBytes ?? MAX_IMPORT_FILE_BYTES).finally(() => {
      onInitialFileConsumed?.();
    });
  }, [handleFileSelected, initialFile, initialFileMaxBytes, onInitialFileConsumed, open]);

  useEffect(() => () => parseAbortRef.current?.abort(), []);

  useLayoutEffect(() => {
    if (!open) {
      // 关闭会话只取消在途解析，不重置退出动画中的可见内容；下次打开会由新的 content key 建立全新草稿。
      parseAbortRef.current?.abort();
      parseAbortRef.current = null;
      return;
    }
  }, [open]);

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-border bg-secondary/20 px-4 py-5 pr-12 sm:px-6 sm:pr-14">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-primary">
            <FileUp className="h-5 w-5" />
          </div>
          <div className="min-w-0 text-left">
            <DialogTitle className="text-xl">{t("import.title")}</DialogTitle>
            <DialogDescription className="mt-1 text-left">{t("import.description")}</DialogDescription>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 overflow-hidden rounded-lg border border-border bg-background/70 text-xs">
          <ImportStep active done label={t("import.stepSelect")} />
          <ImportStep active={Boolean(preview)} done={Boolean(preview)} label={t("import.stepPreview")} />
          <ImportStep active={Boolean(preview && preview.summary.errors === 0)} label={t("import.stepApply")} />
        </div>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
        <Tabs value={mode} onValueChange={(value) => setMode(value as "file" | "paste")} className="space-y-4">
          <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:min-w-80">
            <TabsTrigger value="file" className="gap-2">
              <Archive className="h-4 w-4" />
              {t("import.tabFile")}
            </TabsTrigger>
            <TabsTrigger value="paste" className="gap-2">
              <FileJson className="h-4 w-4" />
              {t("import.tabPaste")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="mt-0 space-y-3">
            <ImportFileDropZone
              file={file}
              dragActive={dragActive}
              fileInputRef={fileInputRef}
              uploadButtonRef={uploadButtonRef}
              onFileSelected={(nextFile) => void handleFileSelected(nextFile)}
              onFileDrop={(event) => void handleFileDrop(event)}
              onDragActiveChange={setDragActive}
              chooseFileLabel={t("import.chooseFile")}
              fileEmptyLabel={t("import.fileEmpty")}
              fileHintLabel={t("import.fileHint")}
            />
          </TabsContent>

          <TabsContent value="paste" className="mt-0 space-y-3">
            <ImportPastePanel
              value={pasteValue}
              parsing={parsing}
              onChange={setPasteValue}
              onPreview={() => void handlePastePreview()}
              placeholder={t("import.pastePlaceholder")}
              previewLabel={t("import.preview")}
            />
          </TabsContent>
        </Tabs>

        {error && (
          <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {parsing && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t("import.loading")}
          </div>
        )}

        {vaultCredentialsCount > 0 && (
          <div className="grid gap-2 rounded-lg border border-border bg-secondary/20 p-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <Label htmlFor="import-backup-passphrase" className="text-sm font-medium text-foreground">
                {t("import.vaultPassphraseLabel")}
              </Label>
            </div>
            <Input
              id="import-backup-passphrase"
              type="password"
              value={backupPassphrase}
              onChange={(event) => setBackupPassphrase(event.target.value)}
              className="border-border bg-background"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("import.vaultPassphraseHint", { count: vaultCredentialsCount })}
            </p>
            <p className="text-xs text-destructive">{t("import.vaultPassphraseWarning")}</p>
          </div>
        )}

        {preview && (
          prepared ? (
            <ImportPreviewPanel
              prepared={prepared}
              preview={preview}
              conflictMode={conflictMode}
              previewFilter={previewFilter}
              skippedIndexes={skippedIndexes}
              forceReplaceIndexes={forceReplaceIndexes}
              wallosUsers={wallosUsers}
              selectedWallosUser={selectedWallosUser}
              assetProgress={assetProgress}
              applyProgress={applyProgress}
              onConflictModeChange={handleConflictModeChange}
              onWallosUserChange={(value) => void handleWallosUserChange(value)}
              onPreviewFilterChange={setPreviewFilter}
              onLogoChange={handleLogoChange}
              onToggleRow={handleToggleRow}
            />
          ) : null
        )}
      </div>

      <DialogFooter className="shrink-0 border-t border-border bg-card px-4 py-4 sm:px-6">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button
          type="button"
          onClick={() => void handleExecuteClick()}
          disabled={!preview || preview.summary.errors > 0 || applying || verifyingPassphrase}
        >
          {applying || verifyingPassphrase ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
          {verifyingPassphrase ? t("import.vaultVerifying") : t("import.apply")}
        </Button>
      </DialogFooter>

      <AlertDialog open={vaultConfirmReason !== null} onOpenChange={(nextOpen) => { if (!nextOpen) setVaultConfirmReason(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {vaultConfirmReason === "invalid" ? t("import.vaultInvalidConfirmTitle") : t("import.vaultSkipConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {vaultConfirmReason === "invalid"
                ? t("import.vaultInvalidConfirmDescription", { count: vaultCredentialsCount })
                : t("import.vaultSkipConfirmDescription", { count: vaultCredentialsCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("import.vaultSkipConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                // 保留原密码提交：预检已确认 GCM 失败，apply 会按 invalid 跳过凭据并恢复其他数据。
                setVaultConfirmReason(null);
                void handleApply();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("import.vaultSkipConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
