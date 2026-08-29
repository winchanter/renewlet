/**
 * 品牌符号组件（Renewo）。
 *
 * 架构位置：所有登录/setup/空状态入口共用同一个 SVG，避免品牌图形在页面中复制分叉。
 *
 * 注意： SVG 使用 currentColor 继承外层主题色；不要在组件内写死颜色。
 */
import type { SVGProps } from "react";

/** 渲染 Renewo v10 品牌符号：主环（currentColor）+ 主题色短弧与内收翼箭头（环即品牌名中的 "o"，箭头表达循环续费）；线宽较 v10 原稿加粗。 */
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
        d="M 19.902 13.252 A 8 8 0 1 1 11.47 4.02"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M 14.34 4.35 A 8 8 0 0 1 19.128 8.368"
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path d="M 19.06 8.24 L 21.44 7.35 L 20.97 11.99 L 16.95 9.64 Z" fill="hsl(var(--primary))" />
    </svg>
  );
}
