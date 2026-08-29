/**
 * 品牌符号组件（Renewo）。
 *
 * 架构位置：所有登录/setup/空状态入口共用同一个 SVG，避免品牌图形在页面中复制分叉。
 *
 * 注意： SVG 使用 currentColor 继承外层主题色；不要在组件内写死颜色。
 */
import type { SVGProps } from "react";

/** 渲染 Renewo 的续费环形品牌符号（环即品牌名中的 "o"，缺口箭头表达循环续费）。 */
export function RenewletLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M 14.63 7.45 A 5.25 5.25 0 1 1 9.38 7.45"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M 8.78 6.42 L 11 6.52 L 9.98 8.49 Z" fill="hsl(var(--primary))" />
    </svg>
  );
}
