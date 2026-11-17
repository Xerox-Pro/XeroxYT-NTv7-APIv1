CREATE TABLE IF NOT EXISTS user_terms_acceptances(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,version TEXT NOT NULL,accepted_at INTEGER NOT NULL,PRIMARY KEY(user_id,version));
