-- Only in-site section and the public video title, never full URLs, search queries or DM text.
ALTER TABLE account_presence ADD COLUMN page TEXT NOT NULL DEFAULT '';
ALTER TABLE account_presence ADD COLUMN title TEXT NOT NULL DEFAULT '';
