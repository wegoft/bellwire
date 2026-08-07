-- SPDX-License-Identifier: AGPL-3.0-only
PRAGMA foreign_keys = ON;

-- Bellwire keeps the public domain model in JSON while promoting every field
-- used for identity, ownership, ordering, expiry, and worker claims to indexed
-- columns. This keeps migrations explicit without coupling the Worker to a
-- PostgREST-shaped transport.
CREATE TABLE bellwire_entities (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT,
  parent_id TEXT,
  alternate_key TEXT,
  secondary_key TEXT,
  state TEXT,
  timestamp TEXT,
  expires_at TEXT,
  display_order INTEGER,
  revision INTEGER,
  attempt_count INTEGER,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (kind, id)
);

CREATE INDEX bellwire_entities_owner_idx
  ON bellwire_entities (kind, owner_id, timestamp);
CREATE INDEX bellwire_entities_parent_idx
  ON bellwire_entities (kind, parent_id, timestamp);
CREATE INDEX bellwire_entities_alternate_idx
  ON bellwire_entities (kind, alternate_key);
CREATE INDEX bellwire_entities_compound_idx
  ON bellwire_entities (kind, parent_id, alternate_key, secondary_key);
CREATE INDEX bellwire_entities_state_idx
  ON bellwire_entities (kind, state, timestamp);

CREATE UNIQUE INDEX bellwire_project_slug_uidx
  ON bellwire_entities (owner_id, alternate_key)
  WHERE kind = 'project';
CREATE UNIQUE INDEX bellwire_device_apns_uidx
  ON bellwire_entities (alternate_key)
  WHERE kind = 'device';
CREATE UNIQUE INDEX bellwire_device_installation_uidx
  ON bellwire_entities (owner_id, secondary_key)
  WHERE kind = 'device';
CREATE UNIQUE INDEX bellwire_binding_code_uidx
  ON bellwire_entities (alternate_key)
  WHERE kind = 'device_binding';
CREATE UNIQUE INDEX bellwire_agent_token_hash_uidx
  ON bellwire_entities (alternate_key)
  WHERE kind = 'agent_token';
CREATE UNIQUE INDEX bellwire_ingest_token_hash_uidx
  ON bellwire_entities (alternate_key)
  WHERE kind = 'ingest_token';
CREATE UNIQUE INDEX bellwire_private_wake_token_hash_uidx
  ON bellwire_entities (alternate_key)
  WHERE kind = 'private_wake_token';
CREATE UNIQUE INDEX bellwire_event_idempotency_uidx
  ON bellwire_entities (parent_id, alternate_key)
  WHERE kind = 'event';
CREATE UNIQUE INDEX bellwire_private_wake_idempotency_uidx
  ON bellwire_entities (parent_id, alternate_key)
  WHERE kind = 'private_wake';
CREATE UNIQUE INDEX bellwire_delivery_target_uidx
  ON bellwire_entities (kind, parent_id, alternate_key)
  WHERE kind IN ('delivery', 'private_wake_delivery');
CREATE UNIQUE INDEX bellwire_live_surface_key_uidx
  ON bellwire_entities (parent_id, alternate_key)
  WHERE kind = 'live_surface';
CREATE UNIQUE INDEX bellwire_configuration_version_uidx
  ON bellwire_entities (kind, parent_id, alternate_key, revision)
  WHERE kind IN ('event_schema', 'notification_surface');
CREATE UNIQUE INDEX bellwire_device_key_installation_uidx
  ON bellwire_entities (owner_id, alternate_key)
  WHERE kind = 'device_key';
CREATE UNIQUE INDEX bellwire_live_activity_session_uidx
  ON bellwire_entities (parent_id, alternate_key)
  WHERE kind = 'live_activity_registration';
CREATE UNIQUE INDEX bellwire_pending_mode_request_uidx
  ON bellwire_entities (parent_id)
  WHERE kind = 'delivery_mode_change_request' AND state = 'pending';
CREATE UNIQUE INDEX bellwire_entitlement_original_transaction_uidx
  ON bellwire_entities (alternate_key)
  WHERE kind = 'entitlement' AND alternate_key IS NOT NULL;

CREATE TABLE ingest_rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);

CREATE TABLE signal_usage (
  user_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  accepted_signals INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period_start)
);

-- The acceptance ledger is the idempotency and accounting boundary. Its
-- trigger makes quota accounting part of the same D1 transaction as accepting
-- an event, private wake, or hosted surface update.
CREATE TABLE signal_acceptances (
  signal_key TEXT PRIMARY KEY,
  claim_token TEXT NOT NULL,
  user_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE TRIGGER signal_acceptances_increment_usage
AFTER INSERT ON signal_acceptances
BEGIN
  INSERT INTO signal_usage (user_id, period_start, accepted_signals)
  VALUES (NEW.user_id, NEW.period_start, 1)
  ON CONFLICT (user_id, period_start) DO UPDATE SET
    accepted_signals = accepted_signals + 1;
END;

CREATE TABLE apple_notification_receipts (
  notification_uuid TEXT PRIMARY KEY,
  notification_type TEXT NOT NULL,
  subtype TEXT,
  signed_date TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE migration_ledger (
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_updated_at TEXT,
  checksum TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (source_table, source_id)
);

-- The public waitlist is closed. Historical rows are retained here for audit
-- and deletion requests; no application route writes to this table.
CREATE TABLE waitlist_archive (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  source_payload TEXT NOT NULL CHECK (json_valid(source_payload))
);
