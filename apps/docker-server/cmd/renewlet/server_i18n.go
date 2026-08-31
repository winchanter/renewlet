package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"golang.org/x/text/language"
)

const defaultAppLocale = localeEnUS

// 服务端 catalog 是 Go/Worker 的唯一文案源；前端错误展示只共享 code，不共享这里的翻译文本。
//
//go:embed i18n/active.*.json
var serverI18nFS embed.FS

var (
	serverI18nCatalogs = mustLoadServerI18nCatalogs()
	serverI18nLocales  = sortedServerI18nLocales(serverI18nCatalogs)
	serverI18nTags     = serverI18nLanguageTags(serverI18nLocales)
	serverI18nMatcher  = language.NewMatcher(serverI18nTags)
)

func mustLoadServerI18nCatalogs() map[appLocale]map[string]string {
	catalogs := map[appLocale]map[string]string{}
	entries, err := fs.ReadDir(serverI18nFS, "i18n")
	if err != nil {
		panic(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, "active.") || !strings.HasSuffix(name, ".json") {
			continue
		}
		locale := appLocale(strings.TrimSuffix(strings.TrimPrefix(name, "active."), ".json"))
		// embed.FS 的路径分隔符恒为 '/'；filepath.Join 在 Windows 会生成 '\'，导致 ReadFile 找不到嵌入文件。
		data, err := serverI18nFS.ReadFile("i18n/" + name)
		if err != nil {
			panic(err)
		}
		var catalog map[string]string
		if err := json.Unmarshal(data, &catalog); err != nil {
			panic(err)
		}
		catalogs[locale] = catalog
	}
	if _, ok := catalogs[defaultAppLocale]; !ok {
		panic(fmt.Sprintf("missing default server i18n catalog %s", defaultAppLocale))
	}
	return catalogs
}

func sortedServerI18nLocales(catalogs map[appLocale]map[string]string) []appLocale {
	locales := make([]appLocale, 0, len(catalogs))
	for locale := range catalogs {
		if locale != defaultAppLocale {
			locales = append(locales, locale)
		}
	}
	sort.Slice(locales, func(i, j int) bool { return locales[i] < locales[j] })
	return append([]appLocale{defaultAppLocale}, locales...)
}

func serverI18nLanguageTags(locales []appLocale) []language.Tag {
	tags := make([]language.Tag, 0, len(locales))
	for _, locale := range locales {
		tags = append(tags, language.MustParse(string(locale)))
	}
	return tags
}

func matchAppLocale(value string) (appLocale, bool) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "_", "-"))
	if value == "" {
		return defaultAppLocale, false
	}
	tag, err := language.Parse(value)
	if err != nil {
		return defaultAppLocale, false
	}
	_, index, confidence := serverI18nMatcher.Match(tag)
	if confidence == language.No {
		return defaultAppLocale, false
	}
	return serverI18nLocales[index], true
}

func normalizeAppLocale(value string) appLocale {
	if locale, ok := matchAppLocale(value); ok {
		return locale
	}
	return defaultAppLocale
}

func isSupportedAppLocale(value string) bool {
	_, ok := serverI18nCatalogs[appLocale(value)]
	return ok
}

func matchAcceptLanguage(header string) appLocale {
	// ParseAcceptLanguage 已按 q 值和出现顺序排序；Matcher 只负责把浏览器偏好折到服务端支持集。
	tags, _, err := language.ParseAcceptLanguage(header)
	if err != nil || len(tags) == 0 {
		return defaultAppLocale
	}
	_, index, confidence := serverI18nMatcher.Match(tags...)
	if confidence == language.No {
		return defaultAppLocale
	}
	return serverI18nLocales[index]
}

func serverText(locale appLocale, key string) string {
	if catalog, ok := serverI18nCatalogs[locale]; ok {
		if message, ok := catalog[key]; ok {
			return message
		}
	}
	if message, ok := serverI18nCatalogs[defaultAppLocale][key]; ok {
		return message
	}
	return key
}

func serverFormat(locale appLocale, key string, params map[string]interface{}) string {
	return serverFormatMessage(serverText(locale, key), params)
}

func serverFormatMessage(message string, params map[string]interface{}) string {
	for name, value := range params {
		message = strings.ReplaceAll(message, "{"+name+"}", fmt.Sprint(value))
	}
	return message
}

func localizedDisabledBanReason(locale appLocale) string {
	return serverText(locale, "auth.accountDisabledByAdmin")
}
