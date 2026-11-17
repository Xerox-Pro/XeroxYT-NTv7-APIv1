CREATE TABLE account_visual_modes_next (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','chaos','chaos2','jelly','spin')),
  updated_at INTEGER NOT NULL
);
INSERT INTO account_visual_modes_next SELECT user_id,mode,updated_at FROM account_visual_modes;
DROP TABLE account_visual_modes;
ALTER TABLE account_visual_modes_next RENAME TO account_visual_modes;
