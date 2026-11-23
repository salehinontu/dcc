CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per signed-in device. A token is only accepted while its `jti` has a live row
-- here, which is what lets a password change, a role change or a sign-out end a session
-- before its JWT expires. `user_id` is deliberately not a foreign key: deleting an account
-- must not fail, and a missing row is rejected by the lookup anyway.
CREATE TABLE IF NOT EXISTS sessions (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateways (
  sn TEXT PRIMARY KEY,
  workspace_id TEXT,
  model TEXT,
  online BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,
  firmware TEXT
);

CREATE TABLE IF NOT EXISTS gateway_credentials (
  gateway_sn TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_credentials_username ON gateway_credentials (username);

CREATE TABLE IF NOT EXISTS devices (
  sn TEXT PRIMARY KEY,
  gateway_sn TEXT,
  workspace_id TEXT,
  model TEXT,
  display_name TEXT,
  domain INTEGER,
  type INTEGER,
  sub_type INTEGER,
  control_index INTEGER,
  online BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,
  live_capacity JSONB,
  cameras JSONB
);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS label TEXT;
-- A video-only drone (DJI Fly pushing RTMP) has no controller: this secret key is its identity.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS rtmp_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS devices_rtmp_key ON devices (rtmp_key) WHERE rtmp_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS telemetry_samples (
  id BIGSERIAL PRIMARY KEY,
  device_sn TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  alt_rel DOUBLE PRECISION,
  alt_abs DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  speed_h DOUBLE PRECISION,
  speed_v DOUBLE PRECISION,
  battery_pct DOUBLE PRECISION,
  mode INTEGER,
  gnss INTEGER,
  rtk INTEGER,
  raw JSONB
);

CREATE INDEX IF NOT EXISTS telemetry_device_ts ON telemetry_samples (device_sn, ts DESC);

CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  device_sn TEXT NOT NULL,
  video_id TEXT NOT NULL,
  stream_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  quality INTEGER NOT NULL,
  playback JSONB,
  error TEXT,
  requested_by TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ
);

ALTER TABLE streams ADD COLUMN IF NOT EXISTS rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The boot-time reset and the unique index are applied by db.ts: `migrate()` runs the
-- reset only when the API starts, so a CLI command cannot stop live streams.
CREATE INDEX IF NOT EXISTS streams_state_updated ON streams (state, updated_at);

CREATE TABLE IF NOT EXISTS device_events (
  id BIGSERIAL PRIMARY KEY,
  device_sn TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  payload JSONB
);

CREATE TABLE IF NOT EXISTS mqtt_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  topic TEXT NOT NULL,
  payload JSONB,
  valid BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS mqtt_log_ts ON mqtt_log (ts DESC);

-- Still frames captured from a live feed. `storage_key` is the file name inside
-- SCREENSHOT_DIR; it is never returned to clients.
CREATE TABLE IF NOT EXISTS screenshots (
  id TEXT PRIMARY KEY,
  device_sn TEXT NOT NULL,
  device_label TEXT,
  mission_id TEXT,
  filename TEXT NOT NULL UNIQUE,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  captured_at TIMESTAMPTZ NOT NULL,
  operator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  alt_rel DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS screenshots_captured ON screenshots (captured_at DESC);
CREATE INDEX IF NOT EXISTS screenshots_device_captured ON screenshots (device_sn, captured_at DESC);

-- People counted on a still. The model's detections are kept as they were; `marks` and
-- `verified_count` are the operator-checked result and stay NULL until someone saves one.
-- Re-running the model clears the verification.
CREATE TABLE IF NOT EXISTS screenshot_people (
  screenshot_id TEXT PRIMARY KEY REFERENCES screenshots (id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'thorough',
  model TEXT NOT NULL,
  ai_count INTEGER NOT NULL,
  detections JSONB NOT NULL,
  duration_ms INTEGER,
  analyzed_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  marks JSONB,
  verified_count INTEGER,
  verified_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ
);

ALTER TABLE screenshot_people ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'thorough';

-- A controller may connect only after an operator has signed in with a pilot account and an
-- admin has approved the serial. `pending` is created by the first login attempt; it never
-- receives MQTT credentials. Deliberately not backfilled here: schema.sql runs on every
-- boot, and an INSERT ... ON CONFLICT DO NOTHING would silently re-approve a controller an
-- admin had rejected. Backfill is a one-time step in docs/deployment.md.
CREATE TABLE IF NOT EXISTS controller_enrollments (
  controller_sn TEXT PRIMARY KEY,
  workspace_id TEXT,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS controller_enrollments_status ON controller_enrollments (status, created_at DESC);

-- The aircraft a controller has been approved for. Topology may only claim these.
CREATE TABLE IF NOT EXISTS controller_aircraft (
  controller_sn TEXT NOT NULL REFERENCES controller_enrollments (controller_sn) ON DELETE CASCADE,
  aircraft_sn TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (controller_sn, aircraft_sn)
);

-- Additive migration: existing accounts retain their previous capabilities.
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS all_drones BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS drone_permissions JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
UPDATE users SET permissions = CASE
  WHEN role IN ('admin', 'superadmin') THEN '["users.manage","drones.view","drones.rename","drones.delete","drones.bind","telemetry.view","streams.view","streams.control","screenshots.view","screenshots.capture","system.debug"]'::jsonb
  WHEN role = 'pilot' THEN '["drones.view","drones.bind"]'::jsonb
  ELSE '["drones.view","telemetry.view","streams.view","screenshots.view","screenshots.capture"]'::jsonb END
WHERE permissions IS NULL;
ALTER TABLE users ALTER COLUMN permissions SET DEFAULT '[]'::jsonb;
ALTER TABLE users ALTER COLUMN permissions SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
ALTER TABLE devices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Disabled is not deleted. A disabled aircraft is hidden and its data is refused, exactly
-- like a deleted one, but an admin can switch it back on. Deletion means "this aircraft is
-- gone", and only the original controller can undo it, because holding that RC is the only
-- proof of custody. Keeping the two markers separate is what stops a maintenance pause from
-- being confused with a lost-aircraft decision.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE gateway_credentials ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
ALTER TABLE gateway_credentials ADD COLUMN IF NOT EXISTS session_version INTEGER;

-- Legacy MQTT credentials cannot be associated with an account; force controller login.
UPDATE gateway_credentials SET revoked = TRUE WHERE user_id IS NULL AND revoked = FALSE;

-- ---------------------------------------------------------------------------------------
-- Zones, flights and alerts.

-- The colour an aircraft is drawn in.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS color TEXT;

-- No-fly zones and geofences. `shape` is {type:'circle',center,radiusM} or {type:'polygon',ring}.
-- Deleting a zone only sets `deleted_at`, so a deleted built-in zone is not seeded again.
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'custom',
  shape JSONB NOT NULL,
  buffer_m DOUBLE PRECISION NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  device_sns JSONB NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'custom',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- One row per flight: from take-off to landing (or until the aircraft went silent). The path
-- itself is the telemetry already stored; these columns are its summary.
CREATE TABLE IF NOT EXISTS flights (
  id TEXT PRIMARY KEY,
  device_sn TEXT NOT NULL,
  operator_email TEXT,
  controller_sn TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_s INTEGER NOT NULL DEFAULT 0,
  distance_m DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_alt_m DOUBLE PRECISION,
  max_speed_ms DOUBLE PRECISION,
  avg_speed_ms DOUBLE PRECISION,
  min_battery_pct DOUBLE PRECISION,
  start_lat DOUBLE PRECISION,
  start_lon DOUBLE PRECISION,
  end_lat DOUBLE PRECISION,
  end_lon DOUBLE PRECISION,
  max_range_m DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS flights_device_started ON flights (device_sn, started_at DESC);
CREATE INDEX IF NOT EXISTS flights_started ON flights (started_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  device_sn TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  flight_id TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  alt_rel DOUBLE PRECISION,
  distance_m DOUBLE PRECISION NOT NULL,
  message TEXT NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT
);

-- Alerts about the aircraft itself (link lost, battery) belong to no zone. Dropping a NOT NULL that is
-- already gone does nothing, so this is safe to run every start.
ALTER TABLE alerts ALTER COLUMN zone_id DROP NOT NULL;
ALTER TABLE alerts ALTER COLUMN zone_name DROP NOT NULL;
ALTER TABLE alerts ALTER COLUMN distance_m DROP NOT NULL;

CREATE INDEX IF NOT EXISTS alerts_raised ON alerts (raised_at DESC);
CREATE INDEX IF NOT EXISTS alerts_device_raised ON alerts (device_sn, raised_at DESC);
CREATE INDEX IF NOT EXISTS alerts_flight ON alerts (flight_id);

-- Accounts created before these permissions existed: administrators get the new ones, and
-- accounts that could already watch aircraft may open the flight history. Idempotent.
UPDATE users SET permissions = permissions || '["zones.manage"]'::jsonb
  WHERE role = 'admin' AND NOT permissions ? 'zones.manage';
UPDATE users SET permissions = permissions || '["flights.view"]'::jsonb
  WHERE role IN ('admin', 'user', 'viewer', 'subadmin') AND permissions ? 'drones.view'
    AND NOT permissions ? 'flights.view';
-- Deleting a screenshot is its own right. Administrators have it; everyone else is given it by an Admin.
UPDATE users SET permissions = permissions || '["screenshots.delete"]'::jsonb
  WHERE role = 'admin' AND NOT permissions ? 'screenshots.delete';

-- ---------------------------------------------------------------------------------------
-- Roles: Developer (was superadmin), Admin, Sub-admin (was user and viewer), Pilot.
-- Idempotent: once renamed, nothing matches again.
UPDATE users SET role = 'developer' WHERE role = 'superadmin';
UPDATE users SET role = 'subadmin' WHERE role IN ('user', 'viewer');
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'subadmin';

-- Pilot profiles were removed: the dashboard shows aircraft, not the people flying them.
-- Pilot accounts stay (they sign the remote controller in). Idempotent.
ALTER TABLE devices DROP COLUMN IF EXISTS crew_id;
ALTER TABLE flights DROP COLUMN IF EXISTS crew_id;
DROP TABLE IF EXISTS crew_members;
UPDATE users SET permissions = permissions - 'crew.manage' WHERE permissions ? 'crew.manage';

-- A Pilot account's access is fixed: see and bind every aircraft, nothing else. Idempotent.
UPDATE users SET permissions = '["drones.view","drones.bind"]'::jsonb, all_drones = TRUE,
    drone_permissions = '{}'::jsonb
  WHERE role = 'pilot' AND (permissions <> '["drones.view","drones.bind"]'::jsonb
    OR NOT all_drones OR drone_permissions <> '{}'::jsonb);

-- A password an administrator sets is the real password: no account is made to replace it at
-- first sign-in any more, and accounts already waiting to do so are released. Idempotent.
UPDATE users SET must_change_password = FALSE WHERE must_change_password;

-- Every Admin is its own customer: `admin_id` says which Admin an account belongs to (an Admin
-- belongs to itself, a Developer to none), and `created_by` who made it. An Admin, and a
-- Sub-admin working for it, only see and manage the accounts with the same `admin_id`; a
-- Developer sees them all. NULL on a Sub-admin or Pilot means "no Admin": only Developers see it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by TEXT;
CREATE INDEX IF NOT EXISTS users_admin ON users (admin_id);
UPDATE users SET admin_id = id WHERE role = 'admin' AND admin_id IS DISTINCT FROM id;

-- One-time: accounts that predate this have no owner. Where the installation has exactly one
-- Admin they were that Admin's, so they stay visible to it; with several, only a Developer sees
-- them until it assigns them. The mark makes this run once, so a Developer's own accounts are
-- never claimed later.
CREATE TABLE IF NOT EXISTS schema_marks (
  name TEXT PRIMARY KEY,
  done_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
WITH mark AS (
  INSERT INTO schema_marks (name) VALUES ('users_admin_id') ON CONFLICT DO NOTHING RETURNING name
)
UPDATE users SET admin_id = (SELECT min(id) FROM users WHERE role = 'admin')
  WHERE admin_id IS NULL AND role IN ('subadmin', 'pilot')
    AND EXISTS (SELECT 1 FROM mark)
    AND (SELECT count(*) FROM users WHERE role = 'admin') = 1;

-- Each screen is its own grant, so a Developer can open exactly the ones a customer's Admin should
-- have. Before this every account saw the map and the zones, accounts that could see a drone saw
-- the alerts, and `users.manage` also opened the controller and drone inventory. One time only (the
-- mark): a screen a Developer switches off later must not come back at the next start. Pilots are
-- fixed and have none of these.
WITH mark AS (
  INSERT INTO schema_marks (name) VALUES ('screen_permissions') ON CONFLICT DO NOTHING RETURNING name
)
UPDATE users SET permissions = permissions
    || CASE WHEN permissions ? 'map.view' THEN '[]'::jsonb ELSE '["map.view"]'::jsonb END
    || CASE WHEN permissions ? 'zones.view' THEN '[]'::jsonb ELSE '["zones.view"]'::jsonb END
    || CASE WHEN permissions ? 'alerts.view'
         OR NOT (permissions ? 'drones.view' OR drone_permissions <> '{}'::jsonb)
       THEN '[]'::jsonb ELSE '["alerts.view"]'::jsonb END
    || CASE WHEN permissions ? 'inventory.manage' OR NOT permissions ? 'users.manage'
       THEN '[]'::jsonb ELSE '["inventory.manage"]'::jsonb END
  WHERE role <> 'pilot' AND EXISTS (SELECT 1 FROM mark);

-- The Live wall, Screenshots, Flight history and Drones screens are grants of their own too. Whoever
-- could already watch video, open stills, read flights or see a drone (on every drone or on any
-- one) keeps the screen. One time only (the mark), so one switched off later stays off.
WITH mark AS (
  INSERT INTO schema_marks (name) VALUES ('screen_permissions_2') ON CONFLICT DO NOTHING RETURNING name
)
UPDATE users SET permissions = permissions
    || CASE WHEN permissions ? 'wall.view' OR NOT (permissions ? 'streams.view'
         OR EXISTS (SELECT 1 FROM jsonb_each(drone_permissions) e WHERE e.value ? 'streams.view'))
       THEN '[]'::jsonb ELSE '["wall.view"]'::jsonb END
    || CASE WHEN permissions ? 'shots.view' OR NOT (permissions ? 'screenshots.view'
         OR EXISTS (SELECT 1 FROM jsonb_each(drone_permissions) e WHERE e.value ? 'screenshots.view'))
       THEN '[]'::jsonb ELSE '["shots.view"]'::jsonb END
    || CASE WHEN permissions ? 'history.view' OR NOT (permissions ? 'flights.view'
         OR EXISTS (SELECT 1 FROM jsonb_each(drone_permissions) e WHERE e.value ? 'flights.view'))
       THEN '[]'::jsonb ELSE '["history.view"]'::jsonb END
    || CASE WHEN permissions ? 'fleet.view' OR NOT (permissions ? 'drones.view'
         OR EXISTS (SELECT 1 FROM jsonb_each(drone_permissions) e WHERE e.value ? 'drones.view'))
       THEN '[]'::jsonb ELSE '["fleet.view"]'::jsonb END
  WHERE role <> 'pilot' AND EXISTS (SELECT 1 FROM mark);

-- Video the server records itself (see packages/protocol/src/recordings.ts). One row per clip: an
-- MP4 file under RECORDING_DIR, named in `file` relative to it. A recording is the clips that share
-- `session_id`. `operator_email` is plain text like flights keep it, so a deleted account leaves
-- the clip with the name of whoever started it.
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  device_sn TEXT,
  mode TEXT NOT NULL DEFAULT 'manual',
  source TEXT NOT NULL DEFAULT 'drone',
  title TEXT,
  folder TEXT,
  state TEXT NOT NULL DEFAULT 'ready',
  error TEXT,
  tenant_id TEXT,
  file TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_s INTEGER NOT NULL,
  size_bytes BIGINT NOT NULL,
  operator_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recordings_started ON recordings (started_at DESC);
CREATE INDEX IF NOT EXISTS recordings_device_started ON recordings (device_sn, started_at DESC);
CREATE INDEX IF NOT EXISTS recordings_session ON recordings (session_id);

-- Uploads (footage recorded elsewhere and uploaded through the dashboard) share this table. An upload
-- has no drone unless its uploader picks one, a `folder` and a `title` it was given, the customer it
-- belongs to (`tenant_id`, the Admin of the uploader) and a `state` while the server makes it
-- playable. A database that already has the first version of the table is brought up to date here.
ALTER TABLE recordings ALTER COLUMN device_sn DROP NOT NULL;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'drone';
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS folder TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS tenant_id TEXT;
-- Tags and a note a person adds to a video, so it can be found again (the search matches both).
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS note TEXT;
CREATE INDEX IF NOT EXISTS recordings_upload_folder ON recordings (tenant_id, folder) WHERE source = 'upload';

-- The three recording grants go to every existing Admin once (the mark), as the Admin runs the
-- installation and the new grants are part of "everything". A Sub-admin keeps exactly what it was
-- given, and an Admin limited to selected drones is given recordings on a drone by the Developer.
WITH mark AS (
  INSERT INTO schema_marks (name) VALUES ('recordings_permissions') ON CONFLICT DO NOTHING RETURNING name
)
UPDATE users SET permissions = permissions
    || CASE WHEN permissions ? 'recordings.view' THEN '[]'::jsonb ELSE '["recordings.view"]'::jsonb END
    || CASE WHEN permissions ? 'recordings.record' THEN '[]'::jsonb ELSE '["recordings.record"]'::jsonb END
    || CASE WHEN permissions ? 'recordings.delete' THEN '[]'::jsonb ELSE '["recordings.delete"]'::jsonb END
  WHERE role = 'admin' AND EXISTS (SELECT 1 FROM mark);

-- Uploading is an account-level right (it belongs to no drone). Every existing Admin gets it once;
-- a Sub-admin has it only when an Admin grants it.
WITH mark AS (
  INSERT INTO schema_marks (name) VALUES ('recordings_upload_permission') ON CONFLICT DO NOTHING RETURNING name
)
UPDATE users SET permissions = permissions
    || CASE WHEN permissions ? 'recordings.upload' THEN '[]'::jsonb ELSE '["recordings.upload"]'::jsonb END
  WHERE role = 'admin' AND EXISTS (SELECT 1 FROM mark);

-- The Recordings screen is a grant of its own (`recs.view`), like the other screens. Whoever could already watch
-- recordings (on every drone or on any one) or upload videos keeps the screen. One time only (the mark), so one
-- switched off later stays off.
WITH mark AS (
  INSERT INTO schema_marks (name) VALUES ('recs_permission') ON CONFLICT DO NOTHING RETURNING name
)
UPDATE users SET permissions = permissions
    || CASE WHEN permissions ? 'recs.view' OR NOT (permissions ? 'recordings.view' OR permissions ? 'recordings.upload'
         OR EXISTS (SELECT 1 FROM jsonb_each(drone_permissions) e WHERE e.value ? 'recordings.view'))
       THEN '[]'::jsonb ELSE '["recs.view"]'::jsonb END
  WHERE role <> 'pilot' AND EXISTS (SELECT 1 FROM mark);

-- Automatic recording is a choice per drone: true records it each time it connects, false never, and
-- NULL follows the installation's default (RECORDING_AUTO_DEFAULT).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS auto_record BOOLEAN;

-- Server-wide settings chosen in the app (for now, where the recordings folder is). The value is JSON.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- Two-step sign-in (a time-based code from an authenticator app). The shared secret is stored sealed (AES-256-GCM, see
-- mfa.ts), never as text. totp_enabled_at is NULL until the account has proved it holds the app; totp_last_step is the
-- last thirty-second step a code was accepted for, so a code works once. Wrong codes count in totp_failures and lock
-- the second step for a while (totp_locked_until). A recovery code is stored as a hash and spent by used_at.
-- Wrong passwords in a row, and until when the account's sign-in is locked because of them (see routes/auth.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMPTZ;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_locked_until TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);

-- The audit trail: who did what, to what, when, from where, and how it ended. Lines are only ever added, and each
-- carries a hash of the line before it, so an edit or a missing line shows when the chain is checked. audit_head
-- holds the last link; updating its single row is what keeps two writers (the API and the server console) from
-- both taking the same place in the chain.
CREATE TABLE IF NOT EXISTS audit_head (
  id   SMALLINT PRIMARY KEY CHECK (id = 1),
  n    BIGINT NOT NULL,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL
);
INSERT INTO audit_head (id, n, prev, hash)
  VALUES (1, 0, repeat('0', 64), repeat('0', 64)) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_log (
  seq          BIGINT PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL,
  actor_id     TEXT,
  actor_email  TEXT,
  actor_role   TEXT,
  -- The Admin (customer) whose team the line belongs to; NULL means the vendor alone sees it.
  tenant_id    TEXT,
  action       TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  status       INTEGER,
  target_type  TEXT,
  target_id    TEXT,
  target_label TEXT,
  details      JSONB,
  ip           TEXT,
  user_agent   TEXT,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log (lower(actor_email), ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log (action, ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_tenant ON audit_log (tenant_id, ts DESC);

-- A line a Developer deleted is not dropped (that would break the chain around it): audit_remove() blanks it. Its
-- number, time and both hashes stay, so the chain still holds together across the gap; who, what, where from and
-- the details are cleared, and every screen and export leaves it out. NULL means the line is intact.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ;

-- Nothing else may change a line. The one exception is audit_remove() below, which says so with a setting that
-- lasts for its own transaction only, and which cannot change the line's place in the chain.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
     AND NEW.seq = OLD.seq AND NEW.ts = OLD.ts
     AND NEW.prev_hash = OLD.prev_hash AND NEW.hash = OLD.hash
     AND current_setting('audit.removing', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the audit trail cannot be changed';
END;
$$ LANGUAGE plpgsql;

-- Blanks the given lines and returns how many it blanked. A line that records an earlier deletion
-- ('audit.deleted') is never blanked: a deletion always leaves its trace.
CREATE OR REPLACE FUNCTION audit_remove(ids BIGINT[]) RETURNS INTEGER AS $$
DECLARE
  blanked INTEGER;
BEGIN
  PERFORM set_config('audit.removing', 'on', true);
  UPDATE audit_log
     SET actor_id = NULL, actor_email = NULL, actor_role = NULL, tenant_id = NULL,
         action = 'audit.removed', outcome = 'success', status = NULL,
         target_type = NULL, target_id = NULL, target_label = NULL,
         details = NULL, ip = NULL, user_agent = NULL, redacted_at = now()
   WHERE seq = ANY(ids) AND redacted_at IS NULL AND action <> 'audit.deleted';
  GET DIAGNOSTICS blanked = ROW_COUNT;
  RETURN blanked;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Admins may open the audit screen: given once, so taking it away from one sticks.
WITH mark AS (
  INSERT INTO schema_marks (name) VALUES ('audit_permission') ON CONFLICT DO NOTHING RETURNING name
)
UPDATE users SET permissions = permissions
    || CASE WHEN permissions ? 'audit.view' THEN '[]'::jsonb ELSE '["audit.view"]'::jsonb END
  WHERE role = 'admin' AND EXISTS (SELECT 1 FROM mark);

-- API access: tokens a customer's own program (an AI analysis tool) reads the data with. Read-only, a narrowed copy
-- of the account that made them (see apps/api/src/api-tokens.ts). Only a SHA-256 of the token is kept, so a copy of
-- the database yields no working token. Deleting the account deletes its tokens.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  -- null: every drone the owner may read.
  device_sns JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens (user_id);

-- Admins may open the API access screen: given once, so taking it away from one sticks.
WITH mark AS (
  INSERT INTO schema_marks (name) VALUES ('api_permission') ON CONFLICT DO NOTHING RETURNING name
)
UPDATE users SET permissions = permissions
    || CASE WHEN permissions ? 'api.manage' THEN '[]'::jsonb ELSE '["api.manage"]'::jsonb END
  WHERE role = 'admin' AND EXISTS (SELECT 1 FROM mark);
