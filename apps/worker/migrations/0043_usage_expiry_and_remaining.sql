-- 量包失效日（可空）：设置后到期边界取 min(耗尽日, 失效日)，与 shared usageExpiresAtSchema 对齐。
ALTER TABLE subscriptions ADD COLUMN usage_expires_at TEXT;
UPDATE subscriptions SET usage_expires_at = NULL WHERE billing_cycle != 'usage-based';

-- usage-based 扣费记录快照：结转余量（默认 0，与 Go NumberField 对齐）与随包失效日（空串 = 未设置）。
ALTER TABLE subscription_billing_records ADD COLUMN usage_remaining_before REAL NOT NULL DEFAULT 0;
ALTER TABLE subscription_billing_records ADD COLUMN usage_expires_at TEXT NOT NULL DEFAULT '';
