-- Delivery and pickup tickets with the customer's signature, quotes, and reservations.
-- New tables only, plus a work-order-style counter for each document number.
-- Existing rentals, invoices and amounts are not changed.

ALTER TABLE company_settings
  ADD COLUMN next_ticket_number INT NOT NULL DEFAULT 1001 CHECK (next_ticket_number > 0),
  ADD COLUMN next_quote_number  INT NOT NULL DEFAULT 1001 CHECK (next_quote_number > 0);

-- ───────────────────────── Delivery and pickup tickets ─────────────────────────
CREATE TABLE delivery_tickets (
  id               BIGSERIAL PRIMARY KEY,
  ticket_number    TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('delivery','pickup')),
  contract_line_id BIGINT NOT NULL REFERENCES rental_contract_lines(id),
  equipment_id     BIGINT NOT NULL REFERENCES equipment(id),
  scheduled_date   DATE NOT NULL,
  time_window      TEXT,
  status           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  driver           TEXT,
  truck            TEXT,
  site_address     TEXT,
  site_contact     TEXT,
  instructions     TEXT,
  -- Filled in at the jobsite.
  hours            NUMERIC(10,1) CHECK (hours >= 0),
  fuel_level       TEXT CHECK (fuel_level IN ('empty','1/4','1/2','3/4','full')),
  condition_notes  TEXT,
  signed_by        TEXT,
  signature_png    BYTEA,
  completed_at     TIMESTAMPTZ,
  completed_by     BIGINT REFERENCES users(id),
  pdf              BYTEA,
  pdf_sha256       TEXT,
  cancel_reason    TEXT,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR (signed_by IS NOT NULL AND signature_png IS NOT NULL AND pdf IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX delivery_tickets_date_idx ON delivery_tickets(scheduled_date) WHERE status = 'scheduled';
CREATE INDEX delivery_tickets_line_idx ON delivery_tickets(contract_line_id);

-- A signed ticket is a permanent record.
CREATE FUNCTION protect_signed_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'completed' THEN RAISE EXCEPTION 'A signed delivery or pickup ticket cannot be changed'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Tickets are cancelled, not deleted'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_tickets_protect BEFORE UPDATE OR DELETE ON delivery_tickets
  FOR EACH ROW EXECUTE FUNCTION protect_signed_ticket();

ALTER TABLE equipment_events DROP CONSTRAINT equipment_events_kind_check;
ALTER TABLE equipment_events ADD CONSTRAINT equipment_events_kind_check CHECK (kind IN
  ('added','moved','status','hours','exchange_out','exchange_in','returned','sold','sale_voided','work_order','service_done','delivered','picked_up'));

-- ───────────────────────── Quotes ─────────────────────────
CREATE TABLE quotes (
  id            BIGSERIAL PRIMARY KEY,
  quote_number  TEXT NOT NULL UNIQUE,
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  quote_date    DATE NOT NULL,
  valid_until   DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined')),
  jobsite       TEXT,
  contact       TEXT,
  notes         TEXT,
  decided_at    TIMESTAMPTZ,
  decided_note  TEXT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until >= quote_date)
);
CREATE INDEX quotes_customer_idx ON quotes(customer_id, quote_date DESC);

CREATE TABLE quote_lines (
  id             BIGSERIAL PRIMARY KEY,
  quote_id       BIGINT NOT NULL REFERENCES quotes(id),
  description    TEXT NOT NULL CHECK (length(btrim(description)) >= 2),
  category       TEXT,
  equipment_id   BIGINT REFERENCES equipment(id),
  quantity       INT NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  rate_amount    NUMERIC(12,2) NOT NULL CHECK (rate_amount >= 0),
  rate_basis     TEXT NOT NULL CHECK (rate_basis IN ('daily','weekly','cycle_28','cycle_30','monthly')),
  start_date     DATE NOT NULL,
  end_date       DATE,
  delivery_charge NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
  pickup_charge  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pickup_charge >= 0),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX quote_lines_quote_idx ON quote_lines(quote_id);

-- Sent, accepted or declined quotes keep their lines as quoted.
CREATE FUNCTION protect_sent_quote_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM quotes WHERE id = COALESCE(NEW.quote_id, OLD.quote_id) AND status <> 'draft') THEN
    RAISE EXCEPTION 'This quote was already sent; copy it to change the prices';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER quote_lines_protect BEFORE INSERT OR UPDATE OR DELETE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION protect_sent_quote_lines();

-- ───────────────────────── Reservations ─────────────────────────
-- Holds a unit (or just a category, until a unit is picked) for a customer's dates.
CREATE TABLE reservations (
  id               BIGSERIAL PRIMARY KEY,
  customer_id      BIGINT NOT NULL REFERENCES customers(id),
  quote_line_id    BIGINT REFERENCES quote_lines(id),
  equipment_id     BIGINT REFERENCES equipment(id),
  category         TEXT,
  description      TEXT NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE,
  rate_amount      NUMERIC(12,2),
  rate_basis       TEXT CHECK (rate_basis IN ('daily','weekly','cycle_28','cycle_30','monthly')),
  status           TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','converted','cancelled')),
  contract_line_id BIGINT REFERENCES rental_contract_lines(id),
  notes            TEXT,
  cancel_reason    TEXT,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (status <> 'converted' OR contract_line_id IS NOT NULL),
  -- One unit can't be reserved twice for overlapping dates.
  EXCLUDE USING gist (equipment_id WITH =, daterange(start_date, COALESCE(end_date, 'infinity'::date), '[]') WITH &&)
    WHERE (status = 'reserved' AND equipment_id IS NOT NULL)
);
CREATE INDEX reservations_start_idx ON reservations(start_date) WHERE status = 'reserved';
