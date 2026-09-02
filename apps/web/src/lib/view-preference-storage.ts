/**
 * 订阅页/公开页视图偏好的 localStorage 缓存。
 *
 * 与 theme-storage 同口径：localStorage 是“下次进入页面的本地记忆”，
 * 不落库、不跨设备；隐私模式不可用时静默降级，不阻断视图切换。
 *
 * 存储约定：
 * - 视图模式（grid/list）以字符串原样存储
 * - 布尔开关以 "1"/"0" 原样存储；缺 key（null）才回退调用方默认值，
 *   这样"用户明确关闭"与"从未选择"可区分（默认开启时关闭态也能被记住）
 */

const SUBSCRIPTION_VIEW_MODE_KEY = "renewlet_subscription_view_mode";
const SUBSCRIPTION_GROUPED_VIEW_KEY = "renewlet_subscription_grouped_view";
const PUBLIC_STATUS_GROUPED_VIEW_KEY = "renewlet_public_status_grouped_view";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式或配额耗尽时静默忽略；当前内存态仍由组件 state 收敛。
  }
}

export type SubscriptionViewMode = "grid" | "list";

/** 读取订阅页视图模式（无值或非法则返回 null，由调用方回退默认值）。 */
export function readSubscriptionViewMode(): SubscriptionViewMode | null {
  const raw = readStorage(SUBSCRIPTION_VIEW_MODE_KEY);
  return raw === "list" || raw === "grid" ? raw : null;
}

/** 写入订阅页视图模式。 */
export function writeSubscriptionViewMode(mode: SubscriptionViewMode): void {
  writeStorage(SUBSCRIPTION_VIEW_MODE_KEY, mode);
}

/** 读取订阅页分组视图开关（无值返回 null，由调用方回退默认值）。 */
export function readSubscriptionGroupedView(): boolean | null {
  const raw = readStorage(SUBSCRIPTION_GROUPED_VIEW_KEY);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

/** 写入订阅页分组视图开关。 */
export function writeSubscriptionGroupedView(enabled: boolean): void {
  writeStorage(SUBSCRIPTION_GROUPED_VIEW_KEY, enabled ? "1" : "0");
}

/** 读取公开页分组视图开关（无值返回 null，由调用方回退默认值）。 */
export function readPublicStatusGroupedView(): boolean | null {
  const raw = readStorage(PUBLIC_STATUS_GROUPED_VIEW_KEY);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

/** 写入公开页分组视图开关。 */
export function writePublicStatusGroupedView(enabled: boolean): void {
  writeStorage(PUBLIC_STATUS_GROUPED_VIEW_KEY, enabled ? "1" : "0");
}
