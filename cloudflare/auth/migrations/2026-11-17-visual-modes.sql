CREATE TABLE IF NOT EXISTS account_visual_modes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','chaos','chaos2','jelly')),
  updated_at INTEGER NOT NULL
);
