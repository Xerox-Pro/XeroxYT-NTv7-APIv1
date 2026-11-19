CREATE TABLE IF NOT EXISTS account_request_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 at INTEGER NOT NULL,
 route TEXT NOT NULL,
 method TEXT NOT NULL,
 status INTEGER NOT NULL,
 duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_request_logs_user_id_id ON account_request_logs(user_id,id);
CREATE INDEX IF NOT EXISTS idx_account_request_logs_at ON account_request_logs(at);
