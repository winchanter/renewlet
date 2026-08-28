-- 续订凭证（截图/发票）的 asset ID JSON 数组；旧记录无凭证时默认 '[]'。
-- 存储为 JSON 字符串而非关联表：凭证跟 billing record 一样是不可变快照，不需要单独查询。
ALTER TABLE subscription_billing_records ADD COLUMN receipt_asset_ids TEXT NOT NULL DEFAULT '[]';
