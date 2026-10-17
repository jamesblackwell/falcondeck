-- Relay schema before native push and guarded device writes (9b82c58f).
-- Kept unchanged as an upgrade regression fixture. Contains no real data.
CREATE TABLE IF NOT EXISTS relay_sessions (
                session_id TEXT PRIMARY KEY,
                pairing_id TEXT NOT NULL,
                daemon_token TEXT NOT NULL,
                daemon_last_seen_at TIMESTAMPTZ NULL,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                next_seq BIGINT NOT NULL DEFAULT 1,
                oldest_lost_seq BIGINT NOT NULL DEFAULT 0
            );
            ALTER TABLE relay_sessions
                ADD COLUMN IF NOT EXISTS next_seq BIGINT NOT NULL DEFAULT 1;
            ALTER TABLE relay_sessions
                ADD COLUMN IF NOT EXISTS oldest_lost_seq BIGINT NOT NULL DEFAULT 0;
            CREATE TABLE IF NOT EXISTS relay_pairings (
                pairing_id TEXT PRIMARY KEY,
                pairing_code TEXT NOT NULL UNIQUE,
                daemon_token TEXT NOT NULL,
                label TEXT NULL,
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                device_id TEXT NULL,
                daemon_bundle JSONB NULL,
                client_bundle JSONB NULL,
                pairing_authority JSONB NULL,
                claim_challenge TEXT NULL,
                pairing_authority_signature TEXT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL
            );
            ALTER TABLE relay_pairings ADD COLUMN IF NOT EXISTS pairing_authority JSONB NULL;
            ALTER TABLE relay_pairings ADD COLUMN IF NOT EXISTS claim_challenge TEXT NULL;
            ALTER TABLE relay_pairings ADD COLUMN IF NOT EXISTS pairing_authority_signature TEXT NULL;
            CREATE TABLE IF NOT EXISTS relay_devices (
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                client_token TEXT NOT NULL UNIQUE,
                label TEXT NULL,
                public_key TEXT NULL,
                identity_public_key TEXT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                last_seen_at TIMESTAMPTZ NULL,
                revoked_at TIMESTAMPTZ NULL,
                push_token TEXT NULL,
                PRIMARY KEY (session_id, device_id)
            );
            ALTER TABLE relay_devices ADD COLUMN IF NOT EXISTS push_token TEXT NULL;
            ALTER TABLE relay_devices ADD COLUMN IF NOT EXISTS identity_public_key TEXT NULL;
            CREATE TABLE IF NOT EXISTS relay_updates (
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                seq BIGINT NOT NULL,
                update_id TEXT NOT NULL UNIQUE,
                body JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                PRIMARY KEY (session_id, seq)
            );
            -- Backfill next_seq for rows that predate the column: sequence
            -- numbers must never be reused after pruning, so derive at least
            -- MAX(seq) + 1 from the retained updates.
            UPDATE relay_sessions SET next_seq = GREATEST(
                next_seq,
                (SELECT COALESCE(MAX(seq) + 1, 1) FROM relay_updates u
                 WHERE u.session_id = relay_sessions.session_id)
            );
            CREATE TABLE IF NOT EXISTS relay_actions (
                action_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES relay_sessions(session_id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                payload JSONB NOT NULL,
                status TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                error TEXT NULL,
                result JSONB NULL
            );
            ALTER TABLE relay_actions
                DROP CONSTRAINT IF EXISTS relay_actions_session_idempotency_key_key;
            ALTER TABLE relay_actions
                DROP CONSTRAINT IF EXISTS relay_actions_session_device_idempotency_key_key;
            ALTER TABLE relay_actions
                ADD CONSTRAINT relay_actions_session_device_idempotency_key_key
                UNIQUE (session_id, device_id, idempotency_key);
            CREATE INDEX IF NOT EXISTS relay_updates_session_seq_idx
                ON relay_updates(session_id, seq);
            CREATE INDEX IF NOT EXISTS relay_actions_session_idx
                ON relay_actions(session_id, created_at);
            CREATE INDEX IF NOT EXISTS relay_devices_session_idx
                ON relay_devices(session_id, created_at);
