/**
 * 品牌 favicon 动态生成工具。
 *
 * 架构位置：ThemeProvider 在主题色变化时调用这里，把 CSS token 转成 data URL favicon，
 * 让浏览器标签页与当前主题保持一致。
 *
 * 注意： 该模块依赖 DOM/CSSOM；服务端或测试环境调用时必须走 fallback。
 */
const FALLBACK_PRIMARY = "25 95% 53%";
const FALLBACK_GLOW = "35 90% 55%";

function readCssHsl(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function ensureFaviconLink(): HTMLLinkElement {
  const existing =
    document.querySelector<HTMLLinkElement>("#renewlet-favicon") ??
    document.querySelector<HTMLLinkElement>('link[rel="icon"]');

  if (existing) {
    existing.id = "renewlet-favicon";
    existing.rel = "icon";
    existing.type = "image/svg+xml";
    return existing;
  }

  const link = document.createElement("link");
  link.id = "renewlet-favicon";
  link.rel = "icon";
  link.type = "image/svg+xml";
  document.head.appendChild(link);
  return link;
}

export function buildBrandFaviconSvg(primary: string, glow: string, isDark: boolean): string {
  const shell = isDark ? "#0C0A09" : "#1C1917";
  const shellMid = "#141210";
  const rim = "#3F3730";
  const ring = "#FAFAF9";

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    "<defs>",
    '<linearGradient id="bg" x1="8" y1="6" x2="58" y2="58" gradientUnits="userSpaceOnUse">',
    '<stop offset="0" stop-color="' + shell + '"/>',
    '<stop offset="0.58" stop-color="' + shellMid + '"/>',
    '<stop offset="1" stop-color="#0C0A09"/>',
    "</linearGradient>",
    '<radialGradient id="glow" cx="46" cy="14" r="44" gradientUnits="userSpaceOnUse">',
    '<stop offset="0" stop-color="hsl(' + glow + ')" stop-opacity="0.22"/>',
    '<stop offset="0.55" stop-color="hsl(' + glow + ')" stop-opacity="0.07"/>',
    '<stop offset="1" stop-color="hsl(' + glow + ')" stop-opacity="0"/>',
    "</radialGradient>",
    '<linearGradient id="ring-accent" x1="20" y1="46" x2="46" y2="18" gradientUnits="userSpaceOnUse">',
    '<stop offset="0" stop-color="hsl(' + glow + ')"/>',
    '<stop offset="1" stop-color="hsl(' + primary + ')"/>',
    "</linearGradient>",
    "</defs>",
    '<rect x="4" y="4" width="56" height="56" rx="18" fill="url(#bg)"/>',
    '<rect x="5.5" y="5.5" width="53" height="53" rx="16.5" fill="url(#glow)" stroke="' + rim + '" stroke-width="1.5"/>',
    '<path d="M 45.83 34.19 A 14 14 0 1 1 31.07 18.03" fill="none" stroke="' + ring + '" stroke-width="3.8" stroke-linecap="round"/>',
    '<path d="M 36.10 18.61 A 14 14 0 0 1 44.47 25.64" fill="none" stroke="url(#ring-accent)" stroke-width="3.8" stroke-linecap="round"/>',
    '<polygon points="44.36,25.43 48.52,23.86 47.70,31.98 40.66,27.87" fill="url(#ring-accent)"/>',
    "</svg>",
  ].join("");
}

export function updateBrandFavicon(): void {
  if (typeof document === "undefined") return;

  const primary = readCssHsl("--primary", FALLBACK_PRIMARY);
  const glow = readCssHsl("--primary-glow", FALLBACK_GLOW);
  const svg = buildBrandFaviconSvg(primary, glow, document.documentElement.classList.contains("dark"));
  const link = ensureFaviconLink();
  link.href = "data:image/svg+xml," + encodeURIComponent(svg);
}
