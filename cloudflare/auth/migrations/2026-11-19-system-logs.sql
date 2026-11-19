-- Live site-wide API metadata. Never store request bodies, full URLs, tokens, IPs, or search terms.
CREATE TABLE IF NOT EXISTS system_request_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 at INTEGER NOT NULL,
 route TEXT NOT NULL,
 method TEXT NOT NULL,
 status INTEGER NOT NULL,
 duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_request_logs_user_id_id ON system_request_logs(user_id,id);
CREATE INDEX IF NOT EXISTS idx_system_request_logs_at ON system_request_logs(at);
