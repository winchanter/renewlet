import { z } from "zod";
import {
  BILLING_CYCLES,
  CUSTOM_CYCLE_UNITS,
  SUBSCRIPTION_STATUSES,
  isValidDateOnly,
} from "../runtime";
import { moneyStringSchema } from "../money";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";
import { exchangeRateSnapshotPublicBasisSchema } from "./exchange-rates";

const publicStatusTokenSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * 登录态公开页管理响应。
 *
 * pageUrl 可展示给用户复制，但 token 不写入 settings/export；撤销后旧 URL 应立即失效。
 */
export const publicStatusPageSchema = z.object({
  enabled: z.boolean(),
  createdAt: z.string().optional(),
  pageUrl: z.string().trim().url().max(4096).optional(),
  showPrices: z.boolean(),
  vaultEnabled: z.boolean(),
  updatedAt: z.string().optional(),
}).strict();

export const publicStatusPagePayloadSchema = z.object({
  publicStatusPage: publicStatusPageSchema,
}).strict();
export const publicStatusPageResponseSchema = apiSuccessResponseSchema(publicStatusPagePayloadSchema);

export const publicStatusPageCreateRequestSchema = z.object({}).strict();

export const publicStatusPageCreatePayloadSchema = z.object({
  publicStatusPage: z.object({
    enabled: z.literal(true),
    createdAt: z.string().trim().min(1),
    pageUrl: z.string().trim().url().max(4096),
    showPrices: z.boolean(),
    vaultEnabled: z.boolean(),
    updatedAt: z.string().trim().min(1),
  }).strict(),
}).strict();
export const publicStatusPageCreateResponseSchema = apiSuccessResponseSchema(publicStatusPageCreatePayloadSchema);

export const publicStatusPageUpdateRequestSchema = z.object({
  showPrices: z.boolean(),
  vaultEnabled: z.boolean(),
}).strict();

export const publicStatusPageDeleteResponseSchema = okResponseSchema;

const publicStatusLogoSchema = z.string().trim().max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return value.startsWith("/api/public/status/");
  }
}, "Invalid public logo URL");

/**
 * 公开订阅投影的 allowlist。
 *
 * 这里故意不包含 notes、website、tags、paymentMethod、extra 和私有 owner 字段；价格字段也必须受 showPrices 控制。
 */
const publicStatusSubscriptionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  logo: publicStatusLogoSchema.optional(),
  category: z.object({
    value: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    color: z.string().trim().max(80).optional(),
  }).strict(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  startDate: z.string().refine(isValidDateOnly).nullable(),
  nextBillingDate: z.string().refine(isValidDateOnly),
  updatedAt: z.string().trim().min(1),
  price: moneyStringSchema.optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  customDays: z.number().int().positive().optional(),
  customCycleUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
  oneTimeTermCount: z.number().int().positive().max(3650).optional(),
  oneTimeTermUnit: z.enum(CUSTOM_CYCLE_UNITS).optional(),
  usageTotal: z.number().finite().positive().max(1_000_000_000).optional(),
  usageDailyRate: z.number().finite().positive().max(1_000_000_000).optional(),
  // 失效日影响月均摊销天数（min 口径），必须随总量/日均一起进入公开投影；空值=未设置。
  usageExpiresAt: z.string().refine(isValidDateOnly).nullable().optional(),
  // 订阅所属组在 payload.groups 数组中的下标；不直接暴露组 id。未分组订阅省略。
  groupIndex: z.number().int().min(0).max(499).optional(),
}).strict().refine((value) => (value.price === undefined) === (value.currency === undefined), {
  path: ["price"],
  message: "Price and currency must be included together",
}).refine((value) => value.price === undefined || value.billingCycle !== undefined, {
  path: ["billingCycle"],
  message: "Billing cycle is required when price is exposed",
}).refine((value) => {
  if (value.billingCycle === undefined) {
    return value.customDays === undefined
      && value.customCycleUnit === undefined
      && value.oneTimeTermCount === undefined
      && value.oneTimeTermUnit === undefined
      && value.usageTotal === undefined
      && value.usageDailyRate === undefined;
  }
  if (value.billingCycle === "custom") {
    return value.customDays !== undefined
      && value.customCycleUnit !== undefined
      && value.oneTimeTermCount === undefined
      && value.oneTimeTermUnit === undefined
      && value.usageTotal === undefined
      && value.usageDailyRate === undefined;
  }
  if (value.billingCycle === "one-time") {
    return value.customDays === undefined
      && value.customCycleUnit === undefined
      && (value.oneTimeTermCount === undefined) === (value.oneTimeTermUnit === undefined)
      && value.usageTotal === undefined
      && value.usageDailyRate === undefined;
  }
  if (value.billingCycle === "usage-based") {
    // 公开页只投影月均摊销所需字段；量包单位不在公开 allowlist。
    return value.customDays === undefined
      && value.customCycleUnit === undefined
      && value.oneTimeTermCount === undefined
      && value.oneTimeTermUnit === undefined
      && value.usageTotal !== undefined
      && value.usageDailyRate !== undefined;
  }
  return value.customDays === undefined
    && value.customCycleUnit === undefined
    && value.oneTimeTermCount === undefined
    && value.oneTimeTermUnit === undefined
    && value.usageTotal === undefined
    && value.usageDailyRate === undefined
    && value.usageExpiresAt === undefined;
}, {
  path: ["billingCycle"],
  message: "Billing cycle fields are inconsistent",
});

/** 公开页账号访问区块：访客申请访问所需的订阅摘要（id+name）。仅 vaultEnabled 开启时输出，列表必须为空。 */
export const publicStatusVaultSubscriptionSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120),
}).strict();
export type PublicStatusVaultSubscription = z.infer<typeof publicStatusVaultSubscriptionSchema>;

export const publicStatusVaultSchema = z.object({
  enabled: z.boolean(),
  subscriptions: z.array(publicStatusVaultSubscriptionSchema).max(500),
}).strict();
export type PublicStatusVault = z.infer<typeof publicStatusVaultSchema>;

/**
 * 公开页订阅组投影：仅组名与 logo（走公开资产代理），不暴露组 id、描述与排序字段。
 *
 * 隐私口径：只输出至少含一条公开可见订阅的组；组 logo 引用的私有资产代理同样校验引用关系。
 */
export const publicStatusGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  logo: publicStatusLogoSchema.nullable().optional(),
}).strict();
export type PublicStatusGroup = z.infer<typeof publicStatusGroupSchema>;

export const publicStatusPayloadSchema = z.object({
  page: z.object({
    title: z.literal("Renewo"),
    showPrices: z.boolean(),
    vaultEnabled: z.boolean(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    exchangeRateBasis: exchangeRateSnapshotPublicBasisSchema.optional(),
    generatedAt: z.string().trim().min(1),
    truncated: z.boolean(),
  }).strict(),
  subscriptions: z.array(publicStatusSubscriptionSchema).max(500),
  // 订阅组投影；Worker 面无组能力恒为空数组。default([]) 兼容旧端缓存的响应。
  groups: z.array(publicStatusGroupSchema).max(500).default([]),
  vault: publicStatusVaultSchema,
}).strict().superRefine((value, context) => {
  // 账号访问关闭时不允许携带订阅摘要，避免访客从关闭页面枚举订阅 id。
  if (!value.vault.enabled && value.vault.subscriptions.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["vault", "subscriptions"],
      message: "Vault subscriptions must be hidden when vault access is disabled",
    });
  }
  // 订阅引用的组下标必须存在；每个输出的组也必须至少被一条可见订阅引用，避免空组名泄露。
  const referencedGroupIndexes = new Set<number>();
  value.subscriptions.forEach((subscription, index) => {
    if (subscription.groupIndex === undefined) return;
    if (subscription.groupIndex >= value.groups.length) {
      context.addIssue({
        code: "custom",
        path: ["subscriptions", index, "groupIndex"],
        message: "Subscription group index is out of range",
      });
      return;
    }
    referencedGroupIndexes.add(subscription.groupIndex);
  });
  value.groups.forEach((_, index) => {
    if (!referencedGroupIndexes.has(index)) {
      context.addIssue({
        code: "custom",
        path: ["groups", index],
        message: "Group must be referenced by at least one visible subscription",
      });
    }
  });
  // showPrices 是公开页隐私开关，金额相关字段必须整组出现或整组隐藏，避免半公开响应被前端误展示。
  if (value.page.showPrices && !value.page.currency) {
    context.addIssue({
      code: "custom",
      path: ["page", "currency"],
      message: "Currency is required when prices are exposed",
    });
  }
  if (!value.page.showPrices && value.page.currency !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["page", "currency"],
      message: "Currency must be hidden when prices are not exposed",
    });
  }
  if (!value.page.showPrices && value.page.exchangeRateBasis !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["page", "exchangeRateBasis"],
      message: "Exchange-rate basis must be hidden when prices are not exposed",
    });
  }
  value.subscriptions.forEach((subscription, index) => {
    const amountFields = [
      subscription.price,
      subscription.currency,
      subscription.billingCycle,
      subscription.customDays,
      subscription.customCycleUnit,
      subscription.oneTimeTermCount,
      subscription.oneTimeTermUnit,
    ];
    const hasAnyAmountProjection = amountFields.some((field) => field !== undefined);
    const hasRequiredAmountProjection = subscription.price !== undefined
      && subscription.currency !== undefined
      && subscription.billingCycle !== undefined;
    if (value.page.showPrices && !hasRequiredAmountProjection) {
      context.addIssue({
        code: "custom",
        path: ["subscriptions", index, "price"],
        message: "Price projection is required when prices are exposed",
      });
    }
    if (!value.page.showPrices && hasAnyAmountProjection) {
      context.addIssue({
        code: "custom",
        path: ["subscriptions", index, "price"],
        message: "Price projection must be hidden when prices are not exposed",
      });
    }
  });
});
export const publicStatusResponseSchema = apiSuccessResponseSchema(publicStatusPayloadSchema);

export type PublicStatusPage = z.infer<typeof publicStatusPageSchema>;
export type PublicStatusPageResponse = z.infer<typeof publicStatusPagePayloadSchema>;
export type PublicStatusPageCreateResponse = z.infer<typeof publicStatusPageCreatePayloadSchema>;
export type PublicStatusPageUpdateRequest = z.infer<typeof publicStatusPageUpdateRequestSchema>;
export type PublicStatusResponse = z.infer<typeof publicStatusPayloadSchema>;
export type PublicStatusToken = z.infer<typeof publicStatusTokenSchema>;
