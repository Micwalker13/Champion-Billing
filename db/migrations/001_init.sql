-- Champion Equipment Rental Billing & PO Management
-- Initial schema. All money columns are NUMERIC(14,2); rates NUMERIC(14,4). No floats anywhere.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────── Users, sessions, audit ─────────────────────────
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','billing_manager','billing_clerk','viewer')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id    BIGINT REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  before     JSONB,
  after      JSONB,
  note       TEXT
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity, entity_id);
-- Audit log is append-only.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── Company settings ─────────────────────────
CREATE TABLE company_settings (
  id                     INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name             TEXT NOT NULL,
  address_line1          TEXT NOT NULL,
  address_line2          TEXT,
  city_state_zip         TEXT NOT NULL,
  phone                  TEXT,
  email                  TEXT,
  remit_to               TEXT,
  invoice_prefix         TEXT NOT NULL DEFAULT 'CE-INV-',
  next_invoice_number    BIGINT NOT NULL DEFAULT 100001,
  is_placeholder         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Customers & billing profiles ─────────────────────────
CREATE TABLE customers (
  id              BIGSERIAL PRIMARY KEY,
  customer_code   TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  billing_address TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_billing_profiles (
  customer_id                  BIGINT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  billing_method               TEXT NOT NULL DEFAULT 'calendar_month'
                                 CHECK (billing_method IN ('daily','weekly','cycle_28','cycle_30','calendar_month')),
  proration_policy             TEXT NOT NULL DEFAULT 'unapproved'
                                 CHECK (proration_policy IN ('unapproved','actual_days','thirty_day_capped','full_period')),
  proration_approved_by        BIGINT REFERENCES users(id),
  proration_approved_at        TIMESTAMPTZ,
  proration_approval_note      TEXT,
  bill_off_rent_day            BOOLEAN NOT NULL DEFAULT TRUE,
  require_monthly_po           BOOLEAN NOT NULL DEFAULT FALSE,
  unique_po_per_unit           BOOLEAN NOT NULL DEFAULT FALSE,
  po_pattern                   TEXT,          -- regular expression, anchored
  po_pattern_description       TEXT,
  require_work_order           BOOLEAN NOT NULL DEFAULT FALSE,
  require_job_number           BOOLEAN NOT NULL DEFAULT FALSE,
  require_jobsite_address      BOOLEAN NOT NULL DEFAULT FALSE,
  require_contract_attachment  BOOLEAN NOT NULL DEFAULT FALSE,
  require_manual_approval      BOOLEAN NOT NULL DEFAULT TRUE,
  invoice_level_po             BOOLEAN NOT NULL DEFAULT FALSE,
  po_variance_tolerance_pct    NUMERIC(7,4) NOT NULL DEFAULT 0,     -- e.g. 2.0000 = 2%
  po_variance_tolerance_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate                     NUMERIC(7,5) NOT NULL DEFAULT 0,     -- e.g. 0.08250
  tax_rate_is_placeholder      BOOLEAN NOT NULL DEFAULT TRUE,
  payment_terms_days           INT NOT NULL DEFAULT 30,
  payment_terms_label          TEXT NOT NULL DEFAULT 'Net 30',
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Equipment & jobsites ─────────────────────────
CREATE TABLE equipment (
  id            BIGSERIAL PRIMARY KEY,
  unit_number   TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL,
  serial_number TEXT,
  make          TEXT,
  model         TEXT,
  year          INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (unit_number = upper(btrim(unit_number)))
);

CREATE TABLE jobsites (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  name        TEXT NOT NULL,
  address     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Rental contracts ─────────────────────────
CREATE TABLE rental_contracts (
  id                  BIGSERIAL PRIMARY KEY,
  contract_number     TEXT NOT NULL UNIQUE,
  customer_id         BIGINT NOT NULL REFERENCES customers(id),
  jobsite_id          BIGINT REFERENCES jobsites(id),
  job_number          TEXT,
  work_order_number   TEXT,
  start_date          DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','off_rent','returned','closed')),
  billing_method      TEXT CHECK (billing_method IN ('daily','weekly','cycle_28','cycle_30','calendar_month')), -- NULL = use customer profile
  payment_terms_days  INT,
  quipli_reference    TEXT,   -- reference only; this app never writes to Quipli
  internal_notes      TEXT,
  created_by          BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rental_contract_lines (
  id                BIGSERIAL PRIMARY KEY,
  contract_id       BIGINT NOT NULL REFERENCES rental_contracts(id),
  equipment_id      BIGINT NOT NULL REFERENCES equipment(id),
  rate_amount       NUMERIC(14,2) NOT NULL CHECK (rate_amount >= 0),
  rate_basis        TEXT NOT NULL CHECK (rate_basis IN ('daily','weekly','cycle_28','cycle_30','monthly')),
  on_rent_date      DATE NOT NULL,
  billing_start_date DATE NOT NULL,  -- first day THIS system bills (earlier days were billed in Quipli)
  off_rent_date     DATE,    -- last billable day handling governed by profile.bill_off_rent_day
  returned_date     DATE,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','off_rent','returned','closed')),
  delivery_charge   NUMERIC(14,2) NOT NULL DEFAULT 0,
  pickup_charge     NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxable           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (off_rent_date IS NULL OR off_rent_date >= on_rent_date),
  CHECK (billing_start_date >= on_rent_date)
);
-- A unit cannot be on two open rentals at once.
CREATE UNIQUE INDEX one_open_line_per_unit ON rental_contract_lines(equipment_id)
  WHERE status IN ('active','off_rent');

CREATE TABLE contract_line_fees (
  id               BIGSERIAL PRIMARY KEY,
  contract_line_id BIGINT NOT NULL REFERENCES rental_contract_lines(id),
  description      TEXT NOT NULL,
  amount           NUMERIC(14,2) NOT NULL,
  frequency        TEXT NOT NULL CHECK (frequency IN ('per_period','one_time')),
  taxable          BOOLEAN NOT NULL DEFAULT TRUE,
  billed_on_invoice_id BIGINT,  -- for one_time fees
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contract_documents (
  id           BIGSERIAL PRIMARY KEY,
  contract_id  BIGINT NOT NULL REFERENCES rental_contracts(id),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  content      BYTEA NOT NULL,
  sha256       TEXT NOT NULL,
  is_original_agreement BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER contract_documents_immutable BEFORE UPDATE OR DELETE ON contract_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── Billing periods ─────────────────────────
-- One row per billable period per rental line. The exclusion constraint makes overlapping
-- periods (double billing) physically impossible for the same machine on the same line.
CREATE TABLE billing_periods (
  id               BIGSERIAL PRIMARY KEY,
  contract_line_id BIGINT NOT NULL REFERENCES rental_contract_lines(id),
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  billing_month    DATE,   -- first day of month for calendar-month billing
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (contract_line_id, period_start),
  EXCLUDE USING gist (contract_line_id WITH =, daterange(period_start, period_end, '[]') WITH &&)
);

-- ───────────────────────── Purchase orders ─────────────────────────
CREATE TABLE import_batches (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  billing_month   DATE NOT NULL CHECK (extract(day FROM billing_month) = 1),
  filename        TEXT NOT NULL,
  file_sha256     TEXT NOT NULL,
  file_content    BYTEA NOT NULL,
  status          TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','applied','cancelled')),
  row_count       INT NOT NULL DEFAULT 0,
  summary         JSONB,
  uploaded_by     BIGINT REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by      BIGINT REFERENCES users(id),
  applied_at      TIMESTAMPTZ,
  cancelled_by    BIGINT REFERENCES users(id),
  cancelled_at    TIMESTAMPTZ
);
-- Same file can only be applied once per customer.
CREATE UNIQUE INDEX import_batches_no_dup_applied ON import_batches(customer_id, file_sha256) WHERE status = 'applied';

CREATE TABLE import_rows (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT NOT NULL REFERENCES import_batches(id),
  row_number        INT NOT NULL,
  raw               JSONB NOT NULL,
  po_number         TEXT,
  unit_number       TEXT,
  work_order_number TEXT,
  job_number        TEXT,
  po_total          NUMERIC(14,2),
  matched_line_id   BIGINT REFERENCES rental_contract_lines(id),
  issues            JSONB NOT NULL DEFAULT '[]',
  expected_total    NUMERIC(14,2),
  decision          TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','skipped')),
  edited            BOOLEAN NOT NULL DEFAULT FALSE,
  decided_by        BIGINT REFERENCES users(id),
  decided_at        TIMESTAMPTZ,
  decision_note     TEXT,
  applied_assignment_id BIGINT,
  UNIQUE (batch_id, row_number)
);

CREATE TABLE purchase_orders (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  po_number       TEXT NOT NULL,
  estimated_total NUMERIC(14,2),
  valid_from      DATE,
  valid_to        DATE,
  expires_on      DATE,
  import_batch_id BIGINT REFERENCES import_batches(id),
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, po_number),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE po_assignments (
  id                BIGSERIAL PRIMARY KEY,
  purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id),
  customer_id       BIGINT NOT NULL REFERENCES customers(id),
  contract_line_id  BIGINT NOT NULL REFERENCES rental_contract_lines(id),
  equipment_id      BIGINT NOT NULL REFERENCES equipment(id),
  billing_period_id BIGINT NOT NULL REFERENCES billing_periods(id),
  job_number        TEXT,
  work_order_number TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','removed')),
  source            TEXT NOT NULL CHECK (source IN ('manual','import','correction')),
  import_row_id     BIGINT REFERENCES import_rows(id),
  reason            TEXT,
  superseded_by     BIGINT REFERENCES po_assignments(id),
  assigned_by       BIGINT REFERENCES users(id),
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_by          BIGINT REFERENCES users(id),
  ended_at          TIMESTAMPTZ
);
-- Exactly one active PO per billing period.
CREATE UNIQUE INDEX po_assignments_one_active_per_period ON po_assignments(billing_period_id) WHERE status = 'active';
CREATE INDEX po_assignments_po_idx ON po_assignments(purchase_order_id);

-- ───────────────────────── Invoices ─────────────────────────
CREATE TABLE invoices (
  id                 BIGSERIAL PRIMARY KEY,
  invoice_number     TEXT UNIQUE,              -- assigned at approval (finalization)
  customer_id        BIGINT NOT NULL REFERENCES customers(id),
  contract_id        BIGINT NOT NULL REFERENCES rental_contracts(id),
  contract_line_id   BIGINT NOT NULL REFERENCES rental_contract_lines(id),
  billing_period_id  BIGINT NOT NULL REFERENCES billing_periods(id),
  po_assignment_id   BIGINT REFERENCES po_assignments(id),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                       ('draft','pending_review','rejected','approved','issued','partially_paid','paid','overdue','voided','corrected')),
  revision_of        BIGINT REFERENCES invoices(id),
  revision_no        INT NOT NULL DEFAULT 0,
  -- Snapshot fields: frozen at finalization (see trigger below)
  po_number          TEXT,
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  invoice_date       DATE,
  due_date           DATE,
  subtotal           NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxable_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate           NUMERIC(7,5) NOT NULL DEFAULT 0,
  tax_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total              NUMERIC(14,2) NOT NULL DEFAULT 0,
  snapshot           JSONB NOT NULL,
  calc_details       JSONB NOT NULL,
  -- Lifecycle
  amount_paid        NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_by         BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_by       BIGINT REFERENCES users(id),
  submitted_at       TIMESTAMPTZ,
  approved_by        BIGINT REFERENCES users(id),
  approved_at        TIMESTAMPTZ,
  finalized_at       TIMESTAMPTZ,
  issued_by          BIGINT REFERENCES users(id),
  issued_at          TIMESTAMPTZ,
  voided_by          BIGINT REFERENCES users(id),
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  rejection_reason   TEXT,
  pdf_sha256         TEXT,
  CHECK (period_end >= period_start)
);
-- At most one live invoice per billing period: no duplicates.
CREATE UNIQUE INDEX invoices_one_live_per_period ON invoices(billing_period_id)
  WHERE status NOT IN ('voided','rejected','corrected');
CREATE INDEX invoices_status_idx ON invoices(status);
CREATE INDEX invoices_customer_idx ON invoices(customer_id, period_start);

CREATE TABLE invoice_lines (
  id           BIGSERIAL PRIMARY KEY,
  invoice_id   BIGINT NOT NULL REFERENCES invoices(id),
  line_no      INT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('rental','delivery','pickup','fee','adjustment')),
  description  TEXT NOT NULL,
  quantity     NUMERIC(14,4) NOT NULL,
  unit         TEXT NOT NULL,
  unit_price   NUMERIC(14,4) NOT NULL,
  amount       NUMERIC(14,2) NOT NULL,
  taxable      BOOLEAN NOT NULL,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE invoice_attachments (
  id                   BIGSERIAL PRIMARY KEY,
  invoice_id           BIGINT NOT NULL REFERENCES invoices(id),
  contract_document_id BIGINT NOT NULL REFERENCES contract_documents(id),
  attached_by          BIGINT REFERENCES users(id),
  attached_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, contract_document_id)
);

-- The finalized PDF is stored once and never regenerated.
CREATE TABLE invoice_documents (
  invoice_id   BIGINT PRIMARY KEY REFERENCES invoices(id),
  pdf          BYTEA NOT NULL,
  sha256       TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER invoice_documents_immutable BEFORE UPDATE OR DELETE ON invoice_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE invoice_status_history (
  id          BIGSERIAL PRIMARY KEY,
  invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  user_id     BIGINT REFERENCES users(id),
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT
);

CREATE TABLE invoice_overrides (
  id          BIGSERIAL PRIMARY KEY,
  invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
  rule        TEXT NOT NULL,
  message     TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, rule)
);

CREATE TABLE payments (
  id          BIGSERIAL PRIMARY KEY,
  invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  paid_on     DATE NOT NULL,
  method      TEXT,
  reference   TEXT,
  recorded_by BIGINT REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Historical invoice integrity ─────────────────────────
-- Once finalized_at is set, the billing period, PO, money, lines and snapshot can never change.
CREATE FUNCTION protect_finalized_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.finalized_at IS NOT NULL OR OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Invoice % cannot be deleted', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.finalized_at IS NOT NULL THEN
    IF NEW.po_number IS DISTINCT FROM OLD.po_number
       OR NEW.po_assignment_id IS DISTINCT FROM OLD.po_assignment_id
       OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
       OR NEW.billing_period_id <> OLD.billing_period_id
       OR NEW.contract_line_id <> OLD.contract_line_id
       OR NEW.subtotal <> OLD.subtotal OR NEW.taxable_amount <> OLD.taxable_amount
       OR NEW.tax_rate <> OLD.tax_rate OR NEW.tax_amount <> OLD.tax_amount OR NEW.total <> OLD.total
       OR NEW.snapshot <> OLD.snapshot OR NEW.calc_details <> OLD.calc_details
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.finalized_at <> OLD.finalized_at
       OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 THEN
      RAISE EXCEPTION 'Invoice % is finalized; use a revision, void/reissue or credit-and-rebill instead', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_protect_finalized BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION protect_finalized_invoice();

CREATE FUNCTION protect_finalized_invoice_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fin TIMESTAMPTZ;
BEGIN
  SELECT finalized_at INTO fin FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF fin IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice lines are frozen once the invoice is finalized';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER invoice_lines_protect BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION protect_finalized_invoice_lines();

-- PO assignment history is never deleted; only its status/ending columns can change.
CREATE FUNCTION protect_po_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PO assignments are permanent history'; END IF;
  IF NEW.purchase_order_id <> OLD.purchase_order_id OR NEW.billing_period_id <> OLD.billing_period_id
     OR NEW.contract_line_id <> OLD.contract_line_id OR NEW.assigned_at <> OLD.assigned_at
     OR NEW.job_number IS DISTINCT FROM OLD.job_number OR NEW.work_order_number IS DISTINCT FROM OLD.work_order_number THEN
    RAISE EXCEPTION 'PO assignment % cannot be rewritten; supersede it with a correction', OLD.id;
  END IF;
  IF OLD.status <> 'active' THEN
    -- The only permitted change to an ended row is linking it once to its replacement.
    IF OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL AND NEW.status = OLD.status
       AND NEW.ended_at IS NOT DISTINCT FROM OLD.ended_at AND NEW.ended_by IS NOT DISTINCT FROM OLD.ended_by
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Ended PO assignment % is permanent history', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_assignments_protect BEFORE UPDATE OR DELETE ON po_assignments
  FOR EACH ROW EXECUTE FUNCTION protect_po_assignment();

