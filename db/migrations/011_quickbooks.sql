-- QuickBooks Online sync. Additive only: no existing table or invoice amount changes.
--
-- Finalized invoices, credit memos and payments are queued here by database triggers, so no
-- code path can forget to queue one. A background job sends each queued item to QuickBooks
-- once. QuickBooks never writes back into Champion's invoices.

-- The one connected QuickBooks company. Tokens are stored encrypted (AES-256-GCM).
CREATE TABLE qbo_connection (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  realm_id           TEXT NOT NULL,
  company_name       TEXT,
  environment        TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT NOT NULL,
  access_expires_at  TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  connected_by       BIGINT REFERENCES users(id),
  connected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sync is off until an administrator turns it on. Anything dated before sync_from is never
-- sent, because it was already entered in QuickBooks by hand.
CREATE TABLE qbo_settings (
  id         INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  sync_from  DATE,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR sync_from IS NOT NULL)
);
INSERT INTO qbo_settings(id) VALUES (1);

-- Which QuickBooks customer, item or account each Champion record goes to.
--   customer:        local_key = customers.id
--   item:            local_key = invoice line kind ('rental', 'overtime', ...), 'fee:<fee_types.id>',
--                    'sales_tax' or 'credit_memo'
--   deposit_account: local_key = 'default'
CREATE TABLE qbo_mappings (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('customer','item','deposit_account')),
  local_key  TEXT NOT NULL,
  qbo_id     TEXT NOT NULL,
  qbo_name   TEXT NOT NULL,
  mapped_by  BIGINT REFERENCES users(id),
  mapped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, local_key)
);

-- One row per thing to send. The unique key means an item can never be queued, or sent, twice.
CREATE TABLE qbo_sync_jobs (
  id              BIGSERIAL PRIMARY KEY,
  entity          TEXT NOT NULL CHECK (entity IN ('invoice','invoice_void','credit_memo','payment')),
  entity_id       BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','needs_attention','skipped')),
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  qbo_id          TEXT,
  qbo_link_id     TEXT,   -- credit memos: the $0 payment that applies the credit to its invoice
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  synced_at       TIMESTAMPTZ,
  UNIQUE (entity, entity_id),
  CHECK (status <> 'synced' OR qbo_id IS NOT NULL)
);
CREATE INDEX qbo_sync_jobs_open_idx ON qbo_sync_jobs(id) WHERE status IN ('pending','needs_attention');

-- Sync history is kept: jobs can't be deleted, and a synced job can't change.
CREATE FUNCTION protect_qbo_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'QuickBooks sync records cannot be deleted'; END IF;
  IF OLD.status = 'synced' AND (NEW.status <> 'synced' OR NEW.qbo_id IS DISTINCT FROM OLD.qbo_id) THEN
    RAISE EXCEPTION 'A synced QuickBooks record is read-only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qbo_sync_jobs_protect BEFORE UPDATE OR DELETE ON qbo_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION protect_qbo_job();

-- Queue an invoice when it is finalized (approved), and queue a void when a finalized invoice
-- is later voided or replaced by a corrected revision.
CREATE FUNCTION queue_qbo_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' AND NEW.finalized_at IS NOT NULL THEN
    INSERT INTO qbo_sync_jobs(entity, entity_id) VALUES ('invoice', NEW.id) ON CONFLICT DO NOTHING;
  ELSIF NEW.status IN ('voided','corrected') AND OLD.status IS DISTINCT FROM NEW.status AND OLD.finalized_at IS NOT NULL THEN
    INSERT INTO qbo_sync_jobs(entity, entity_id) VALUES ('invoice_void', NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_queue_qbo AFTER UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION queue_qbo_invoice();

CREATE FUNCTION queue_qbo_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO qbo_sync_jobs(entity, entity_id) VALUES ('credit_memo', NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_memos_queue_qbo AFTER INSERT ON credit_memos
  FOR EACH ROW EXECUTE FUNCTION queue_qbo_credit();

CREATE FUNCTION queue_qbo_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO qbo_sync_jobs(entity, entity_id) VALUES ('payment', NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_queue_qbo AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION queue_qbo_payment();
