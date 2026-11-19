-- Track foreground browser tabs, without recording visited pages, titles or URLs.
CREATE TABLE IF NOT EXISTS account_presence (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tab_id TEXT NOT NULL,
 last_seen INTEGER NOT NULL,
 PRIMARY KEY (user_id, tab_id)
);
CREATE INDEX IF NOT EXISTS account_presence_last_seen ON account_presence(last_seen);
