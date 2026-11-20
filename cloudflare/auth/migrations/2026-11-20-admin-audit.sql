CREATE TABLE IF NOT EXISTS admin_action_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  target_id TEXT,
  target TEXT,
  action TEXT NOT NULL,
  before_value TEXT NOT NULL,
  after_value TEXT NOT NULL
);
