CREATE TABLE IF NOT EXISTS account_management (
  user_id TEXT PRIMARY KEY,
  mode TEXT,
  monitoring INTEGER NOT NULL DEFAULT 0 CHECK (monitoring IN (0,1))
);
