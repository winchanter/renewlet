ALTER TABLE subscriptions ADD COLUMN usage_unit TEXT;
ALTER TABLE subscriptions ADD COLUMN usage_total REAL;
ALTER TABLE subscriptions ADD COLUMN usage_daily_rate REAL;

-- 用量字段是 usage-based 专用；历史行不存在该周期，统一清空保持写入边界的成组一致契约。
UPDATE subscriptions
SET usage_unit = NULL,
    usage_total = NULL,
    usage_daily_rate = NULL
WHERE billing_cycle != 'usage-based';
