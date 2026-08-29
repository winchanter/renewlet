package main

// 版本测试聚焦 fork 本地部署脱钩后的版本检查行为、Release feed 的 stable/RC 选择逻辑和 Docker 能力矩阵，不执行真实下载或替换。

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

// fork 本地部署脱钩上游后，版本检查只回显当前版本：不请求 release feed，也不产生更新提示。
func TestForkVersionCheckReportsCurrentVersionWithoutUpstreamCall(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0-rc.1", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})
	t.Setenv("RENEWLET_SELF_UPDATE_ENABLED", "false")

	client := &fakeSystemReleaseClient{releases: []systemRelease{releaseFixture("v0.2.0-rc.2")}}
	service := newSystemUpdateService(client)

	first, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.CheckVersion(context.Background(), localeZhCN, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&client.fetchCount); got != 0 {
		t.Fatalf("fork deployment must not call FetchReleases, calls = %d", got)
	}
	for name, response := range map[string]*systemVersionResponse{"force": first, "cached": second} {
		if !response.CheckSucceeded || response.HasUpdate {
			t.Fatalf("%s response should report current version: %#v", name, response)
		}
		if response.LatestVersion != "0.1.0-rc.1" {
			t.Fatalf("%s latestVersion = %q, want current version", name, response.LatestVersion)
		}
		if response.ReleaseInfo != nil {
			t.Fatalf("%s releaseInfo = %#v, want nil without upstream feed", name, response.ReleaseInfo)
		}
	}
	if !second.Cached {
		t.Fatal("second check should come from cache")
	}
}

func TestSelfUpdateCapabilityMatrix(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("self-update capability matrix depends on linux Docker binary semantics")
	}

	oldVersion, oldBuildType := Version, BuildType
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	cases := []struct {
		name           string
		buildType      string
		enabled        string
		writeBinary    bool
		wantDeployment string
		wantMode       string
		wantSupported  bool
		wantReasonPart string
	}{
		{
			name:           "docker release supports in-app binary update",
			buildType:      "release",
			enabled:        "true",
			writeBinary:    true,
			wantDeployment: "docker",
			wantMode:       "in-app-binary",
			wantSupported:  true,
		},
		{
			name:           "docker release with self update disabled falls back to compose",
			buildType:      "release",
			enabled:        "false",
			writeBinary:    true,
			wantDeployment: "docker",
			wantMode:       "docker-compose",
			wantSupported:  false,
			wantReasonPart: "RENEWLET_SELF_UPDATE_ENABLED=false",
		},
		{
			name:           "old docker bridge cannot replace container binary",
			buildType:      "release",
			enabled:        "true",
			writeBinary:    false,
			wantDeployment: "docker",
			wantMode:       "docker-compose",
			wantSupported:  false,
			wantReasonPart: "docker compose pull",
		},
		{
			name:           "non release source build stays manual",
			buildType:      "source",
			enabled:        "true",
			writeBinary:    true,
			wantDeployment: "source",
			wantMode:       "source-manual",
			wantSupported:  false,
			wantReasonPart: "Release",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tempDir := t.TempDir()
			binaryPath := filepath.Join(tempDir, "renewlet")
			if tc.writeBinary {
				if err := os.WriteFile(binaryPath, []byte("old"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("RENEWLET_SELF_UPDATE_ENABLED", tc.enabled)
			t.Setenv("RENEWLET_SELF_UPDATE_BINARY", binaryPath)
			t.Setenv("RENEWLET_SELF_UPDATE_BACKUP_DIR", filepath.Join(tempDir, "backups"))
			Version, BuildType = "1.0.0", tc.buildType

			got := selfUpdateCapability(localeZhCN)
			if got.deployment != tc.wantDeployment {
				t.Fatalf("deployment = %q, want %q", got.deployment, tc.wantDeployment)
			}
			if got.updateMode != tc.wantMode {
				t.Fatalf("updateMode = %q, want %q", got.updateMode, tc.wantMode)
			}
			if got.supported != tc.wantSupported {
				t.Fatalf("supported = %v, want %v", got.supported, tc.wantSupported)
			}
			if tc.wantReasonPart != "" && !strings.Contains(got.unsupportedReason, tc.wantReasonPart) {
				t.Fatalf("unsupportedReason = %q, want to contain %q", got.unsupportedReason, tc.wantReasonPart)
			}
		})
	}
}

func TestStableVersionSkipsRCEntriesFromFeed(t *testing.T) {
	client := &fakeSystemReleaseClient{releases: []systemRelease{
		{TagName: "v0.2.0-rc.1"},
	}}
	service := newSystemUpdateService(client)

	release, err := service.fetchLatestStableRelease(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&client.fetchCount); got != 1 {
		t.Fatalf("FetchReleases calls = %d, want 1", got)
	}
	if release != nil {
		t.Fatalf("stable channel must skip prerelease entries, got %#v", release.dto)
	}
}

func TestStableVersionSelectsLatestStableReleaseFromFeed(t *testing.T) {
	client := &fakeSystemReleaseClient{releases: []systemRelease{
		releaseFixture("v0.2.0-rc.1"),
		releaseFixture("v0.1.1"),
	}}
	service := newSystemUpdateService(client)

	release, err := service.fetchLatestStableRelease(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if release == nil || release.dto.Version != "0.1.1" {
		t.Fatalf("expected latest stable 0.1.1 from feed, got %#v", release)
	}
}

func TestRCVersionSelectsHighestNewerRC(t *testing.T) {
	oldVersion := Version
	Version = "0.1.0-rc.1"
	t.Cleanup(func() {
		Version = oldVersion
	})

	client := &fakeSystemReleaseClient{releases: []systemRelease{
		releaseFixture("v0.1.0"),
		releaseFixture("v0.1.0-rc.2"),
		releaseFixture("v0.2.0-rc.1"),
		releaseFixture("v0.2.0-beta.1"),
		releaseFixture("v0.1.0-rc.1"),
	}}
	service := newSystemUpdateService(client)

	release, err := service.fetchLatestRCRelease(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&client.fetchCount); got != 1 {
		t.Fatalf("FetchReleases calls = %d, want 1", got)
	}
	if release == nil || release.dto.Version != "0.2.0-rc.1" {
		t.Fatalf("expected highest newer rc candidate 0.2.0-rc.1, got %#v", release)
	}
}

func TestSystemVersionReleaseAssetsStayArrayWhenEmpty(t *testing.T) {
	oldVersion := Version
	Version = "0.1.0-rc.1"
	t.Cleanup(func() {
		Version = oldVersion
	})

	service := newSystemUpdateService(&fakeSystemReleaseClient{releases: []systemRelease{
		{
			TagName:     "v0.1.0-rc.2",
			Name:        "Renewo 0.1.0-rc.2",
			PublishedAt: "2026-06-04T00:00:00Z",
			HTMLURL:     "https://github.com/zhiyingzzhou/renewlet/releases/tag/v0.1.0-rc.2",
			Assets:      nil,
		},
	}})

	release, err := service.fetchLatestRCRelease(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if release == nil || release.dto == nil {
		t.Fatal("expected rc candidate from feed")
	}
	// ReleaseInfo 是前端 Zod 校验的 API 契约；空附件列表无论新构造还是缓存克隆都必须编成 []，不能是 null。
	fresh := &systemVersionResponse{ReleaseInfo: release.dto}
	cached := cloneSystemVersionResponse(fresh, true)
	for name, response := range map[string]*systemVersionResponse{"fresh": fresh, "cached": cached} {
		payload, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(payload), `"assets":[]`) {
			t.Fatalf("%s response JSON = %s, want releaseInfo.assets as []", name, payload)
		}
		if strings.Contains(string(payload), `"assets":null`) {
			t.Fatalf("%s response JSON = %s, must not encode assets as null", name, payload)
		}
	}
}

func TestSystemVersionDisablesInAppUpdateWhenReleaseAssetsMissing(t *testing.T) {
	cases := []struct {
		name           string
		assets         []systemReleaseAsset
		wantReasonPart string
	}{
		{
			name:           "missing platform archive",
			assets:         []systemReleaseAsset{{Name: "renewlet-docker-v0.1.0-rc.2.zip"}},
			wantReasonPart: systemArchiveName("0.1.0-rc.2"),
		},
		{
			name:           "missing checksums",
			assets:         []systemReleaseAsset{{Name: systemArchiveName("0.1.0-rc.2")}},
			wantReasonPart: "checksums.txt",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason := systemUpdateAssetsUnsupportedReason(localeZhCN, tc.assets, "0.1.0-rc.2")
			if reason == "" {
				t.Fatal("expected unsupported reason when install asset is missing")
			}
			if !strings.Contains(reason, tc.wantReasonPart) {
				t.Fatalf("reason = %q, want to contain %q", reason, tc.wantReasonPart)
			}
		})
	}
}

func TestStableCurrentVersionDoesNotUpdateToRC(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	release := releaseFixture("v0.2.0-rc.1")
	service := newSystemUpdateService(&fakeSystemReleaseClient{release: &release})

	response, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if !response.CheckSucceeded || response.HasUpdate {
		t.Fatalf("stable current version must not update to rc: %#v", response)
	}
}

func TestRCVersionReportsLatestWhenNoNewerCandidateExists(t *testing.T) {
	oldVersion, oldBuildType := Version, BuildType
	Version, BuildType = "0.1.0-rc.1", "release"
	t.Cleanup(func() {
		Version, BuildType = oldVersion, oldBuildType
	})

	service := newSystemUpdateService(&fakeSystemReleaseClient{releases: []systemRelease{
		releaseFixture("v0.1.0"),
		releaseFixture("v0.1.0-rc.1"),
		releaseFixture("v0.2.0-beta.1"),
	}})

	response, err := service.CheckVersion(context.Background(), localeZhCN, true)
	if err != nil {
		t.Fatal(err)
	}
	if !response.CheckSucceeded || response.HasUpdate {
		t.Fatalf("expected successful rc check without update, got %#v", response)
	}
	if response.Warning != "" {
		t.Fatalf("warning = %q, want empty", response.Warning)
	}
	if response.LatestVersion != "0.1.0-rc.1" {
		t.Fatalf("latestVersion = %q, want current version", response.LatestVersion)
	}
}
