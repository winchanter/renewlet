package main

// cloud_backup_export.go 先扫描可恢复 metadata，再把每个私有资产流式写入 0600 临时 ZIP。
// bundle 只持有业务 JSON 和资产定位信息，资产内容与最终 ZIP 都不得复制进进程内大 buffer。

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/zhiyingzzhou/renewlet/apps/docker-server/internal/snapshotzip"
)

func buildCloudBackupExportZip(app core.App, user *core.Record) (cloudBackupSnapshotSource, time.Time, error) {
	startedAt := time.Now()
	exportedAt := time.Now().UTC()
	bundle, err := buildCloudBackupExportBundle(app, user, exportedAt)
	if err != nil {
		return cloudBackupSnapshotSource{}, exportedAt, err
	}
	tempFile, err := os.CreateTemp("", "renewlet-cloud-backup-*.zip")
	if err != nil {
		return cloudBackupSnapshotSource{}, exportedAt, err
	}
	cleanup := func() {
		_ = tempFile.Close()
		_ = os.Remove(tempFile.Name())
	}
	if err := tempFile.Chmod(0o600); err != nil {
		cleanup()
		return cloudBackupSnapshotSource{}, exportedAt, err
	}
	// Open 延迟到 ZIP writer 逐项消费，避免扫描阶段同时打开文件或持有全部图片内容。
	assets := make([]snapshotzip.Asset, 0, len(bundle.Assets))
	for _, asset := range bundle.Assets {
		currentAsset := asset
		assets = append(assets, snapshotzip.Asset{
			Name: currentAsset.Path,
			Size: currentAsset.SizeBytes,
			Open: func() (io.ReadCloser, error) { return openCloudBackupAsset(app, currentAsset) },
		})
	}
	writeResult, err := snapshotzip.Write(tempFile, snapshotzip.Options{
		Assets: assets,
		JSONEntries: []snapshotzip.JSONEntry{
			{Name: "data.json", Value: bundle.Payload},
			{Name: "manifest.json", Value: bundle.Manifest},
		},
		MaxAssetBytes:   maxImageBytes,
		MaxArchiveBytes: cloudBackupSnapshotMaxBytes,
	})
	if err != nil {
		cleanup()
		return cloudBackupSnapshotSource{}, exportedAt, err
	}
	if err := tempFile.Close(); err != nil {
		cleanup()
		return cloudBackupSnapshotSource{}, exportedAt, err
	}
	slog.Info("cloud backup snapshot built",
		"entries", writeResult.Entries,
		"asset_bytes", writeResult.AssetBytes,
		"zip_bytes", writeResult.ArchiveBytes,
		"duration", time.Since(startedAt),
	)
	return cloudBackupSnapshotSource{path: tempFile.Name(), size: writeResult.ArchiveBytes}, exportedAt, nil
}

type cloudBackupExportBundle struct {
	Payload  map[string]interface{}
	Assets   []cloudBackupExportAsset
	Manifest cloudBackupExportManifest
}

type cloudBackupExportAsset struct {
	ID          string
	Path        string
	MimeType    string
	SizeBytes   int64
	StoragePath string
}

type cloudBackupExportManifest struct {
	Kind           string                          `json:"kind"`
	SchemaVersion  int                             `json:"schemaVersion"`
	ExportedAt     string                          `json:"exportedAt"`
	Subscriptions  int                             `json:"subscriptions"`
	Groups         int                             `json:"groups"`
	BillingRecords int                             `json:"billingRecords"`
	Assets         int                             `json:"assets"`
	MissingAssets  []cloudBackupExportMissingAsset `json:"missingAssets"`
}

type cloudBackupExportMissingAsset struct {
	AssetID     string `json:"assetId"`
	Path        string `json:"path"`
	Reference   string `json:"reference"`
	ReferenceID string `json:"referenceId"`
	Reason      string `json:"reason"`
}

type cloudBackupExportAssetCollector struct {
	app           core.App
	userID        string
	assets        []cloudBackupExportAsset
	assetByID     map[string]cloudBackupExportAsset
	missingAssets []cloudBackupExportMissingAsset
}

func newCloudBackupExportAssetCollector(app core.App, userID string) *cloudBackupExportAssetCollector {
	return &cloudBackupExportAssetCollector{
		app:       app,
		userID:    userID,
		assets:    []cloudBackupExportAsset{},
		assetByID: map[string]cloudBackupExportAsset{},
	}
}

func (collector *cloudBackupExportAssetCollector) resolve(assetID string, originalPath string, reference string, referenceID string) (string, bool) {
	if asset, ok := collector.assetByID[assetID]; ok {
		return asset.Path, true
	}
	asset, err := readCloudBackupAsset(collector.app, collector.userID, assetID)
	if err != nil {
		// 私有资产不是 data.json 的事实源；读不到时只进 manifest 审计，避免恢复后留下跨账号不可用的代理路径。
		collector.missingAssets = append(collector.missingAssets, cloudBackupExportMissingAsset{
			AssetID:     assetID,
			Path:        originalPath,
			Reference:   reference,
			ReferenceID: referenceID,
			Reason:      cloudBackupMissingAssetReason(err),
		})
		return "", false
	}
	collector.assets = append(collector.assets, asset)
	collector.assetByID[assetID] = asset
	return asset.Path, true
}

func buildCloudBackupExportBundle(app core.App, user *core.Record, exportedAt time.Time) (cloudBackupExportBundle, error) {
	rows, err := listOwnedSubscriptionRecords(app, user.Id)
	if err != nil {
		return cloudBackupExportBundle{}, err
	}
	assetCollector := newCloudBackupExportAssetCollector(app, user.Id)
	subscriptions := make([]interface{}, 0, len(rows))
	for _, row := range rows {
		subscription, err := subscriptionDetailResponseMap(subscriptionAPIFromRecord(row))
		if err != nil {
			return cloudBackupExportBundle{}, err
		}
		if logo, ok := subscription["logo"].(string); ok {
			if assetID := privateAssetIDFromPath(logo); assetID != "" {
				if assetPath, ok := assetCollector.resolve(assetID, logo, "subscription.logo", row.Id); ok {
					subscription["logo"] = assetPath
				} else {
					delete(subscription, "logo")
				}
			}
		}
		subscriptions = append(subscriptions, subscription)
	}
	groups, err := cloudBackupExportGroups(app, user, assetCollector)
	if err != nil {
		return cloudBackupExportBundle{}, err
	}
	billingRecords, err := cloudBackupExportBillingRecords(app, user, assetCollector)
	if err != nil {
		return cloudBackupExportBundle{}, err
	}
	data := map[string]interface{}{
		"subscriptions": subscriptions,
	}
	if len(groups) > 0 {
		data["groups"] = groups
	}
	if len(billingRecords) > 0 {
		data["billingRecords"] = billingRecords
	}
	// 云快照只导出可恢复的产品资料；账号安全主密钥和 session/MFA/passkey/recovery/ticket 都必须由用户重新建立。
	if settings, ok, err := cloudBackupExportSettings(app, user); err != nil {
		return cloudBackupExportBundle{}, err
	} else if ok {
		data["settings"] = settings
	}
	if config, ok, err := cloudBackupExportCustomConfig(app, user, assetCollector); err != nil {
		return cloudBackupExportBundle{}, err
	} else if ok {
		data["customConfig"] = config
	}
	if snapshots, ok, err := cloudBackupExportExchangeRateSnapshots(app, user); err != nil {
		return cloudBackupExportBundle{}, err
	} else if ok {
		data["exchangeRateSnapshots"] = snapshots
	}
	if len(assetCollector.assets) > 0 {
		exportAssets := make([]interface{}, 0, len(assetCollector.assets))
		for _, asset := range assetCollector.assets {
			exportAssets = append(exportAssets, map[string]interface{}{
				"id":        asset.ID,
				"path":      asset.Path,
				"mimeType":  asset.MimeType,
				"sizeBytes": asset.SizeBytes,
			})
		}
		data["assets"] = exportAssets
	}
	payload := map[string]interface{}{
		"kind":          "renewlet-export",
		"schemaVersion": 1,
		"exportedAt":    exportedAt.Format(time.RFC3339Nano),
		"data":          data,
	}
	manifest := cloudBackupExportManifest{
		Kind:           "renewlet-export",
		SchemaVersion:  1,
		ExportedAt:     exportedAt.Format(time.RFC3339Nano),
		Subscriptions:  len(subscriptions),
		Groups:         len(groups),
		BillingRecords: len(billingRecords),
		Assets:         len(assetCollector.assets),
		MissingAssets:  assetCollector.missingAssets,
	}
	if manifest.MissingAssets == nil {
		manifest.MissingAssets = []cloudBackupExportMissingAsset{}
	}
	return cloudBackupExportBundle{Payload: payload, Assets: assetCollector.assets, Manifest: manifest}, nil
}

func subscriptionDetailResponseMap(subscription subscriptionDetailResponse) (map[string]interface{}, error) {
	data, err := json.Marshal(subscription)
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func cloudBackupExportSettings(app core.App, user *core.Record) (map[string]interface{}, bool, error) {
	record, err := app.FindFirstRecordByFilter("settings", "user = {:user}", dbx.Params{"user": user.Id})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	settings := settingsFromRecord(record)
	data, err := json.Marshal(settings)
	if err != nil {
		return nil, false, err
	}
	var out map[string]interface{}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, false, err
	}
	// 普通云快照永远剔除通知、AI、Webhook 等 secret；新增外部渠道字段必须进入这组边界。
	for _, key := range []string{
		"testPhone", "telegramBotToken", "telegramChatId", "notifyxApiKey", "webhookUrl", "webhookHeaders", "webhookPayload",
		"dingtalkWebhookUrl", "dingtalkSecret", "dingtalkKeyword", "dingtalkTitleTemplate", "dingtalkContentTemplate",
		"wechatWebhookUrl", "wechatAtPhones", "smtpHost", "smtpPort", "smtpSecure", "smtpUser", "smtpPassword",
		"smtpFrom", "smtpReplyTo", "recipientEmail", "barkServerUrl", "barkDeviceKey", "serverchanSendKey",
		"discordWebhookUrl", "discordBotUsername", "discordBotAvatarUrl", "pushplusToken",
	} {
		delete(out, key)
	}
	if ai, ok := out["aiRecognition"].(map[string]interface{}); ok {
		ai["baseUrl"] = ""
		ai["apiKey"] = ""
	}
	return out, true, nil
}

func cloudBackupExportCustomConfig(app core.App, user *core.Record, assetCollector *cloudBackupExportAssetCollector) (interface{}, bool, error) {
	record, err := app.FindFirstRecordByFilter("custom_configs", "user = {:user}", dbx.Params{"user": user.Id})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	data, err := jsonBytesFromValue(record.Get("config"))
	if err != nil || len(bytes.TrimSpace(data)) == 0 {
		return nil, false, err
	}
	var config customConfigPayload
	if err := decodeStrictJSONBytesInto(data, &config, localeZhCN, false); err != nil {
		return nil, false, err
	}
	if err := normalizeCustomConfigPayload(&config); err != nil {
		return nil, false, err
	}
	for index := range config.PaymentMethods {
		icon := strings.TrimSpace(config.PaymentMethods[index].Icon)
		if assetID := privateAssetIDFromPath(icon); assetID != "" {
			if assetPath, ok := assetCollector.resolve(assetID, icon, "customConfig.paymentMethods.icon", config.PaymentMethods[index].ID); ok {
				config.PaymentMethods[index].Icon = assetPath
			} else {
				config.PaymentMethods[index].Icon = ""
			}
		}
	}
	outData, err := json.Marshal(config)
	if err != nil {
		return nil, false, err
	}
	var out interface{}
	if err := json.Unmarshal(outData, &out); err != nil {
		return nil, false, err
	}
	return out, true, nil
}

func readCloudBackupAsset(app core.App, userID string, assetID string) (cloudBackupExportAsset, error) {
	record, err := app.FindRecordById("assets", assetID)
	if err != nil {
		return cloudBackupExportAsset{}, cloudBackupAssetReadError{Reason: "not_found", Err: err}
	}
	if record.GetString("user") != userID {
		return cloudBackupExportAsset{}, cloudBackupAssetReadError{Reason: "not_found", Err: errors.New("ASSET_NOT_FOUND")}
	}
	filename := record.GetString("file")
	if filename == "" {
		return cloudBackupExportAsset{}, cloudBackupAssetReadError{Reason: "file_missing", Err: errors.New("ASSET_FILE_MISSING")}
	}
	fsys, err := app.NewFilesystem()
	if err != nil {
		return cloudBackupExportAsset{}, cloudBackupAssetReadError{Reason: "read_failed", Err: err}
	}
	defer fsys.Close()
	reader, err := fsys.GetReader(record.BaseFilesPath() + "/" + filename)
	if err != nil {
		return cloudBackupExportAsset{}, cloudBackupAssetReadError{Reason: "file_missing", Err: err}
	}
	defer reader.Close()
	size := reader.Size()
	if size < 0 {
		size = int64(record.GetInt("sizeBytes"))
	}
	if size < 0 || size > maxImageBytes {
		return cloudBackupExportAsset{}, cloudBackupAssetReadError{Reason: "too_large", Err: errors.New("ASSET_TOO_LARGE")}
	}
	mimeType := strings.TrimSpace(record.GetString("mimeType"))
	if mimeType == "" {
		mimeType = reader.ContentType()
	}
	return cloudBackupExportAsset{
		ID:          assetID,
		Path:        "assets/" + assetID + extensionFromCloudBackupMime(mimeType, filename),
		MimeType:    mimeType,
		SizeBytes:   size,
		StoragePath: record.BaseFilesPath() + "/" + filename,
	}, nil
}

type cloudBackupAssetStream struct {
	io.Reader
	close func() error
}

func (stream *cloudBackupAssetStream) Close() error {
	return stream.close()
}

func openCloudBackupAsset(app core.App, asset cloudBackupExportAsset) (io.ReadCloser, error) {
	fsys, err := app.NewFilesystem()
	if err != nil {
		return nil, err
	}
	reader, err := fsys.GetReader(asset.StoragePath)
	if err != nil {
		_ = fsys.Close()
		return nil, err
	}
	// PocketBase reader 依赖其 filesystem；组合 Close 保证每个 entry 写完就释放两层资源，而不是等整包结束。
	return &cloudBackupAssetStream{Reader: reader, close: func() error {
		readerErr := reader.Close()
		fsErr := fsys.Close()
		if readerErr != nil {
			return readerErr
		}
		return fsErr
	}}, nil
}

type cloudBackupAssetReadError struct {
	Reason string
	Err    error
}

func (err cloudBackupAssetReadError) Error() string {
	if err.Err == nil {
		return err.Reason
	}
	return err.Err.Error()
}

func (err cloudBackupAssetReadError) Unwrap() error {
	return err.Err
}

func cloudBackupMissingAssetReason(err error) string {
	var readErr cloudBackupAssetReadError
	if errors.As(err, &readErr) && readErr.Reason != "" {
		return readErr.Reason
	}
	return "read_failed"
}

func privateAssetIDFromPath(value string) string {
	const prefix = "/api/app/assets/"
	if !strings.HasPrefix(value, prefix) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(value, prefix))
}

// 云备份恢复包的实体上限与导入契约（shared import-export.ts）对齐：
// 超出部分不进包，避免备份包体和恢复事务无界膨胀。
const maxCloudBackupGroups = 100
const maxCloudBackupBillingRecords = 2000

// cloudBackupExportGroups 导出用户分组；组 logo 的私有资产与订阅 logo 走同一收集/缺失审计链路。
func cloudBackupExportGroups(app core.App, user *core.Record, collector *cloudBackupExportAssetCollector) ([]map[string]interface{}, error) {
	rows, err := app.FindRecordsByFilter(
		"subscription_groups",
		"user = {:user}",
		"sortOrder, created, -id",
		maxCloudBackupGroups,
		0,
		dbx.Params{"user": user.Id},
	)
	if err != nil {
		return nil, err
	}
	groups := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		group := map[string]interface{}{
			"id":          row.Id,
			"name":        row.GetString("name"),
			"logo":        nullableString(row.GetString("logo")),
			"description": nullableString(row.GetString("description")),
			"sortOrder":   row.GetInt("sortOrder"),
		}
		if logo := row.GetString("logo"); logo != "" {
			if assetID := privateAssetIDFromPath(logo); assetID != "" {
				if assetPath, ok := collector.resolve(assetID, logo, "group.logo", row.Id); ok {
					group["logo"] = assetPath
				} else {
					// 组 logo 是展示增强：读不到时不阻断备份，data.json 落 null 并由 manifest 记录缺失。
					group["logo"] = nil
				}
			}
		}
		groups = append(groups, group)
	}
	return groups, nil
}

// cloudBackupExportBillingRecords 导出不可变续订流水；凭证资产只收集内容、receiptAssetIds 保留原 ID
// （恢复时前端按 ZIP 内 assets 元数据上传后重写为新资产 ID）。读不到的凭证 ID 直接从快照移除。
func cloudBackupExportBillingRecords(app core.App, user *core.Record, collector *cloudBackupExportAssetCollector) ([]billingRecordItem, error) {
	rows, err := app.FindRecordsByFilter(
		billingRecordsCollectionName,
		"user_id = {:user}",
		"-billing_date,-id",
		maxCloudBackupBillingRecords,
		0,
		dbx.Params{"user": user.Id},
	)
	if err != nil {
		return nil, err
	}
	items := make([]billingRecordItem, 0, len(rows))
	for _, row := range rows {
		item := billingRecordItemFromRecord(row)
		if len(item.ReceiptAssetIds) > 0 {
			kept := make([]string, 0, len(item.ReceiptAssetIds))
			for _, assetID := range item.ReceiptAssetIds {
				// 凭证按 ID 引用（不是路径字段）：resolve 只负责把资产收进 ZIP，data.json 保留原 ID。
				if _, ok := collector.resolve(assetID, "/api/app/assets/"+assetID, "billingRecord.receiptAssetIds", row.Id); ok {
					kept = append(kept, assetID)
				}
			}
			item.ReceiptAssetIds = kept
		}
		items = append(items, item)
	}
	return items, nil
}

func extensionFromCloudBackupMime(mimeType string, filename string) string {
	mimeType = strings.ToLower(mimeType)
	switch {
	case strings.Contains(mimeType, "svg"):
		return ".svg"
	case strings.Contains(mimeType, "webp"):
		return ".webp"
	case strings.Contains(mimeType, "jpeg"):
		return ".jpg"
	case strings.Contains(mimeType, "png"):
		return ".png"
	case strings.Contains(mimeType, "icon"):
		return ".ico"
	default:
		ext := path.Ext(filename)
		if len(ext) > 8 {
			return ""
		}
		return ext
	}
}
