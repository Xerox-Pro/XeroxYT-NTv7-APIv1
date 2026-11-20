CREATE TABLE IF NOT EXISTS managed_account_controls (
  user_id TEXT PRIMARY KEY,
  banned INTEGER CHECK (banned IN (0,1)),
  traffic_stopped INTEGER CHECK (traffic_stopped IN (0,1))
);
