package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/core"
)

const (
	accountSecurityKeyVersion = 1
	accountSecurityKeyBytes   = 32
	accountSecurityKeySalt    = "renewlet:account-security:v1"
)

var (
	errAccountSecurityKeyUnavailable = errors.New("account security key is unavailable")
	accountSecurityKeyCacheMu        sync.Mutex
	accountSecurityKeyCache          = map[string]*accountSecurityKeyRing{}
)

type accountSecurityKeyRing struct {
	totpSeed         []byte
	recoveryCode     []byte
	mfaTicket        []byte
	passkeyChallenge []byte
	vaultData        []byte
}

type accountSecurityKeyFile struct {
	Version int    `json:"version"`
	Key     string `json:"key"`
}

// accountSecurityKeyRingForApp 缓存安装级派生 key ring；缓存 key 用 DataDir 隔离测试/实例，不缓存用户或请求态。
func accountSecurityKeyRingForApp(app core.App) (*accountSecurityKeyRing, error) {
	dataDir := app.DataDir()
	if dataDir == "" {
		return nil, errAccountSecurityKeyUnavailable
	}
	accountSecurityKeyCacheMu.Lock()
	defer accountSecurityKeyCacheMu.Unlock()
	if ring := accountSecurityKeyCache[dataDir]; ring != nil {
		return ring, nil
	}
	master, err := loadOrCreateAccountSecurityMasterKey(dataDir)
	if err != nil {
		return nil, err
	}
	ring, err := deriveAccountSecurityKeyRing(master)
	if err != nil {
		return nil, err
	}
	accountSecurityKeyCache[dataDir] = ring
	return ring, nil
}

func loadOrCreateAccountSecurityMasterKey(dataDir string) ([]byte, error) {
	path := accountSecurityKeyPath(dataDir)
	master, err := readAccountSecurityMasterKey(path)
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		return master, err
	}
	master = make([]byte, accountSecurityKeyBytes)
	if _, err := rand.Read(master); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := writeAccountSecurityMasterKey(path, master); err != nil {
		if errors.Is(err, os.ErrExist) {
			return readAccountSecurityMasterKey(path)
		}
		return nil, err
	}
	return master, nil
}

func readAccountSecurityMasterKey(path string) ([]byte, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var stored accountSecurityKeyFile
	if err := json.Unmarshal(content, &stored); err != nil {
		return nil, fmt.Errorf("%w: invalid account security key file", errAccountSecurityKeyUnavailable)
	}
	if stored.Version != accountSecurityKeyVersion {
		return nil, fmt.Errorf("%w: unsupported account security key version", errAccountSecurityKeyUnavailable)
	}
	master, err := base64.RawURLEncoding.DecodeString(stored.Key)
	if err != nil || len(master) != accountSecurityKeyBytes {
		return nil, fmt.Errorf("%w: invalid account security key material", errAccountSecurityKeyUnavailable)
	}
	return master, nil
}

func writeAccountSecurityMasterKey(path string, master []byte) error {
	payload, err := json.Marshal(accountSecurityKeyFile{
		Version: accountSecurityKeyVersion,
		Key:     base64.RawURLEncoding.EncodeToString(master),
	})
	if err != nil {
		return err
	}
	// 安装级账号安全密钥不进 env，不进数据库；0600 文件让 Docker 零配置同时避免普通导出泄漏 pepper。
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(payload, '\n')); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func deriveAccountSecurityKeyRing(master []byte) (*accountSecurityKeyRing, error) {
	// HKDF Extract 只做一次，四个用途靠 info 分域；缓存命中后登录热路径不会再触碰文件或重复派生。
	prk, err := hkdf.Extract(sha256.New, master, []byte(accountSecurityKeySalt))
	if err != nil {
		return nil, err
	}
	totpSeed, err := deriveAccountSecurityKey(prk, "totp-seed-aes-gcm")
	if err != nil {
		return nil, err
	}
	recoveryCode, err := deriveAccountSecurityKey(prk, "recovery-code-hmac")
	if err != nil {
		return nil, err
	}
	mfaTicket, err := deriveAccountSecurityKey(prk, "mfa-ticket-hmac")
	if err != nil {
		return nil, err
	}
	passkeyChallenge, err := deriveAccountSecurityKey(prk, "passkey-challenge-hmac")
	if err != nil {
		return nil, err
	}
	// vault 凭据（密码/备注）与 TOTP seed 同级隔离：专用派生键让 vault 泄密面不与认证面耦合。
	vaultData, err := deriveAccountSecurityKey(prk, "vault-data-aes-gcm")
	if err != nil {
		return nil, err
	}
	return &accountSecurityKeyRing{
		totpSeed:         totpSeed,
		recoveryCode:     recoveryCode,
		mfaTicket:        mfaTicket,
		passkeyChallenge: passkeyChallenge,
		vaultData:        vaultData,
	}, nil
}

func deriveAccountSecurityKey(prk []byte, info string) ([]byte, error) {
	return hkdf.Expand(sha256.New, prk, info, accountSecurityKeyBytes)
}

// encryptAESGCMWithKey 用 AES-256-GCM 加密并输出 v1.nonce.ciphertext 密文；nonce 每次随机。
// MFA seed 与 vault 密码/备注共用该格式，便于将来统一做密文版本轮换。
func encryptAESGCMWithKey(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	return "v1." + base64.RawURLEncoding.EncodeToString(nonce) + "." + base64.RawURLEncoding.EncodeToString(ciphertext), nil
}

func decryptAESGCMWithKey(key []byte, value string) (string, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return "", errors.New("invalid account security ciphertext")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func accountSecurityKeyPath(dataDir string) string {
	return filepath.Join(dataDir, "system", "account-security-key.v1.json")
}

func resetAccountSecurityKeyRingCacheForTest() {
	accountSecurityKeyCacheMu.Lock()
	defer accountSecurityKeyCacheMu.Unlock()
	accountSecurityKeyCache = map[string]*accountSecurityKeyRing{}
}
