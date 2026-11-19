CREATE TABLE IF NOT EXISTS account_master_grants (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);
