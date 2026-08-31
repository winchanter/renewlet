import { z } from "zod";
import { apiSuccessResponseSchema } from "./api";
import { okResponseSchema } from "./common";
import { logoReferenceSchema } from "./subscriptions";

/**
 * 订阅组（Subscription Group）共享契约。
 *
 * 表示"同一个大服务下的多个订阅"（如 AWS 多账号、Netflix 家庭组）。
 * 与 category（粗分类文本）并存：category 是筛选维度，group 是具体大服务实体。
 * 凭据可绑定到 group（组内所有订阅共享）或 subscription（订阅级子账号）或独立。
 *
 * 只服务 Go/Docker 运行面；Cloudflare Worker 暂不实现。
 */

const groupNameSchema = z.string().trim().min(1).max(120);
const groupDescriptionSchema = z.string().trim().max(500);
const groupSortOrderSchema = z.number().int().min(0);

// ============== 组实体 ==============

export const subscriptionGroupSchema = z.object({
  id: z.string().trim().min(1),
  name: groupNameSchema,
  logo: logoReferenceSchema.nullable(),
  description: groupDescriptionSchema.nullable(),
  sortOrder: groupSortOrderSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export type SubscriptionGroup = z.infer<typeof subscriptionGroupSchema>;

export const subscriptionGroupsListPayloadSchema = z.object({
  groups: z.array(subscriptionGroupSchema),
}).strict();
export const subscriptionGroupsListResponseSchema = apiSuccessResponseSchema(subscriptionGroupsListPayloadSchema);
export type SubscriptionGroupsListPayload = z.infer<typeof subscriptionGroupsListPayloadSchema>;

export const subscriptionGroupResponseSchema = apiSuccessResponseSchema(subscriptionGroupSchema);
export const subscriptionGroupDeleteResponseSchema = okResponseSchema;

// ============== 创建/更新请求 ==============

/** 创建请求：name 必填，其余可选。 */
export const subscriptionGroupCreateRequestSchema = z.object({
  name: groupNameSchema,
  logo: logoReferenceSchema.nullable().optional(),
  description: groupDescriptionSchema.nullable().optional(),
  sortOrder: groupSortOrderSchema.optional(),
}).strict();
export type SubscriptionGroupCreateRequest = z.infer<typeof subscriptionGroupCreateRequestSchema>;

/**
 * 更新请求：PATCH 风格，null 清空，缺省保持不变。
 * name 不可清空（至少 1 字符）。
 */
export const subscriptionGroupUpdateRequestSchema = z.object({
  name: groupNameSchema.nullable().optional(),
  logo: logoReferenceSchema.nullable().optional(),
  description: groupDescriptionSchema.nullable().optional(),
  sortOrder: groupSortOrderSchema.nullable().optional(),
}).strict();
export type SubscriptionGroupUpdateRequest = z.infer<typeof subscriptionGroupUpdateRequestSchema>;

// ============== 组统计 ==============

export const subscriptionGroupStatsSchema = z.object({
  id: z.string().trim().min(1),
  subscriptionCount: z.number().int().nonnegative(),
  credentialCount: z.number().int().nonnegative(),
  // 合计月成本（按默认货币换算后的数值字符串）；无订阅时为 "0"。
  totalMonthlyCost: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
export type SubscriptionGroupStats = z.infer<typeof subscriptionGroupStatsSchema>;
export const subscriptionGroupStatsResponseSchema = apiSuccessResponseSchema(subscriptionGroupStatsSchema);
