ALTER TABLE users ADD COLUMN registration_device TEXT;
CREATE TABLE IF NOT EXISTS account_devices (
  device_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS claim_registration_device
AFTER INSERT ON users WHEN NEW.registration_device IS NOT NULL
BEGIN
  INSERT INTO account_devices(device_hash, user_id) VALUES (NEW.registration_device, NEW.id);
END;
