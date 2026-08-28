-- 扣费记录是订阅每期扣费的事实快照：生成时从订阅复制字段，之后独立演化，不与订阅联动回写。
-- 订阅删除不级联删除记录；name 快照仍是历史行的展示兜底，归属 subscription_id 仅作查询键。
CREATE TABLE IF NOT EXISTS subscription_billing_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  name TEXT NOT NULL,
  billing_date TEXT NOT NULL,
  period_end_date TEXT,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  custom_days INTEGER,
  custom_cycle_unit TEXT,
  one_time_term_count INTEGER,
  one_time_term_unit TEXT,
  usage_unit TEXT,
  usage_total REAL,
  usage_daily_rate REAL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, subscription_id, billing_date, mode)
);

CREATE INDEX IF NOT EXISTS idx_subscription_billing_records_user_billing_date
  ON subscription_billing_records (user_id, billing_date);
