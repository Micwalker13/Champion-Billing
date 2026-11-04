-- Yard inventory, equipment exchanges on a running rental, and equipment sales.
-- Adds tables and columns only. Existing rentals, invoices and amounts are not changed.

-- ───────────────────────── Yards and unit status ─────────────────────────
CREATE TABLE yards (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  address    TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "On rent" is never stored: it comes from the open rental. This status covers the rest of a unit's life.
ALTER TABLE equipment
  ADD COLUMN category     TEXT,
  ADD COLUMN yard_id      BIGINT REFERENCES yards(id),
  ADD COLUMN status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_shop','sold','retired')),
  ADD COLUMN hour_meter   NUMERIC(10,1) CHECK (hour_meter IS NULL OR hour_meter >= 0),
  ADD COLUMN asking_price NUMERIC(14,2) CHECK (asking_price IS NULL OR asking_price >= 0),
  ADD COLUMN notes        TEXT;

-- ───────────────────────── Exchanges (swap a unit on a running rental) ─────────────────────────
-- The rental line keeps running: same agreement, rate, billing cycle and monthly PO. Only the unit changes.
CREATE TABLE equipment_exchanges (
  id               BIGSERIAL PRIMARY KEY,
  contract_line_id BIGINT NOT NULL REFERENCES rental_contract_lines(id),
  exchange_date    DATE NOT NULL,            -- first day the replacement unit is on rent
  out_equipment_id BIGINT NOT NULL REFERENCES equipment(id),
  in_equipment_id  BIGINT NOT NULL REFERENCES equipment(id),
  out_hours        NUMERIC(10,1),
  in_hours         NUMERIC(10,1),
  out_status       TEXT NOT NULL CHECK (out_status IN ('available','in_shop')),
  out_yard_id      BIGINT REFERENCES yards(id),
  reason           TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
  freight_fee_id   BIGINT REFERENCES contract_line_fees(id),
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (out_equipment_id <> in_equipment_id),
  UNIQUE (contract_line_id, exchange_date)
);
CREATE INDEX equipment_exchanges_out_idx ON equipment_exchanges(out_equipment_id);
CREATE TRIGGER equipment_exchanges_append_only BEFORE UPDATE OR DELETE ON equipment_exchanges
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── Equipment sales ─────────────────────────
CREATE TABLE equipment_sales (
  id            BIGSERIAL PRIMARY KEY,
  sale_number   TEXT UNIQUE,                 -- assigned when the sale is finalized
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  equipment_id  BIGINT NOT NULL REFERENCES equipment(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','voided')),
  price         NUMERIC(14,2) NOT NULL CHECK (price >= 0),
  freight       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (freight >= 0),
  taxable       BOOLEAN NOT NULL DEFAULT TRUE,
  tax_rate      NUMERIC(7,5) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate < 1),
  subtotal      NUMERIC(14,2) NOT NULL,
  tax_amount    NUMERIC(14,2) NOT NULL,
  total         NUMERIC(14,2) NOT NULL,
  amount_paid   NUMERIC(14,2) NOT NULL DEFAULT 0,
  terms_days    INT NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 365),
  hours_at_sale NUMERIC(10,1),
  notes         TEXT,
  sale_date     DATE,
  due_date      DATE,
  snapshot      JSONB,
  pdf           BYTEA,
  pdf_sha256    TEXT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_by  BIGINT REFERENCES users(id),
  finalized_at  TIMESTAMPTZ,
  voided_by     BIGINT REFERENCES users(id),
  voided_at     TIMESTAMPTZ,
  void_reason   TEXT
);
-- A unit can be on at most one sale that is not voided.
CREATE UNIQUE INDEX equipment_sales_one_live_per_unit ON equipment_sales(equipment_id) WHERE status <> 'voided';

CREATE FUNCTION protect_finalized_sale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.finalized_at IS NOT NULL THEN RAISE EXCEPTION 'Sale % is finalized and cannot be deleted', OLD.id; END IF;
    RETURN OLD;
  END IF;
  IF OLD.finalized_at IS NOT NULL THEN
    IF NEW.sale_number IS DISTINCT FROM OLD.sale_number OR NEW.customer_id <> OLD.customer_id OR NEW.equipment_id <> OLD.equipment_id
       OR NEW.price <> OLD.price OR NEW.freight <> OLD.freight OR NEW.taxable <> OLD.taxable OR NEW.tax_rate <> OLD.tax_rate
       OR NEW.subtotal <> OLD.subtotal OR NEW.tax_amount <> OLD.tax_amount OR NEW.total <> OLD.total
       OR NEW.sale_date IS DISTINCT FROM OLD.sale_date OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.pdf IS DISTINCT FROM OLD.pdf OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
       OR NEW.finalized_at <> OLD.finalized_at THEN
      RAISE EXCEPTION 'Sale % is finalized; void it and create a new sale instead', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER equipment_sales_protect BEFORE UPDATE OR DELETE ON equipment_sales
  FOR EACH ROW EXECUTE FUNCTION protect_finalized_sale();

CREATE TABLE sale_payments (
  id          BIGSERIAL PRIMARY KEY,
  sale_id     BIGINT NOT NULL REFERENCES equipment_sales(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  paid_on     DATE NOT NULL,
  method      TEXT,
  reference   TEXT,
  recorded_by BIGINT REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Unit history ─────────────────────────
-- Every move, status change, exchange, return and sale, kept permanently.
CREATE TABLE equipment_events (
  id               BIGSERIAL PRIMARY KEY,
  equipment_id     BIGINT NOT NULL REFERENCES equipment(id),
  kind             TEXT NOT NULL CHECK (kind IN ('added','moved','status','hours','exchange_out','exchange_in','returned','sold','sale_voided')),
  event_date       DATE NOT NULL,
  yard_id          BIGINT REFERENCES yards(id),
  status           TEXT,
  hours            NUMERIC(10,1),
  note             TEXT,
  contract_line_id BIGINT REFERENCES rental_contract_lines(id),
  exchange_id      BIGINT REFERENCES equipment_exchanges(id),
  sale_id          BIGINT REFERENCES equipment_sales(id),
  user_id          BIGINT REFERENCES users(id),
  at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX equipment_events_unit_idx ON equipment_events(equipment_id, at);
CREATE TRIGGER equipment_events_append_only BEFORE UPDATE OR DELETE ON equipment_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
