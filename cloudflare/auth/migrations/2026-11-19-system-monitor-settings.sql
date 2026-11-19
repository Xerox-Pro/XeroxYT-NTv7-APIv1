-- Master-controlled system-wide request logging; disabled by default.
CREATE TABLE IF NOT EXISTS system_monitor_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO system_monitor_settings(id,enabled,updated_at) VALUES(1,0,0);
