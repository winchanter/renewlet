import { defineConfig } from "@lingui/conf";

// catalog domain 是人工维护的 i18n 边界；检查器和生成脚本依赖同一组 domain 来防止 descriptor、PO、类型化生成物漂移。
const catalogDomains = [
  "common",
  "legal",
  "custom-config",
  "subscription",
  "auth",
  "settings",
  "settings-access-security",
  "public-status",
  "notification",
  "labels",
  "admin",
  "error",
  "vault",
] as const;

export default defineConfig({
  locales: ["zh-CN", "en-US"],
  sourceLocale: "zh-CN",
  catalogs: catalogDomains.map((domain) => ({
    path: `src/i18n/catalogs/{locale}/${domain}`,
    include: [`src/i18n/descriptors/${domain}.ts`],
  })),
});
