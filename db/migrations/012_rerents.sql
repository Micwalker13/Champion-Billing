-- Re-rents: machines Champion rents from a supplier and rents out to its own customers.
-- Additive: new tables, one new column on equipment (default 'owned'), and one new unit status.
-- Existing rentals, invoices and amounts are not changed.

ALTER TABLE equipment ADD COLUMN ownership TEXT NOT NULL DEFAULT 'owned' CHECK (ownership IN ('owned','re_rent'));
ALTER TABLE equipment DROP CONSTRAINT equipment_status_check;
ALTER TABLE equipment ADD CONSTRAINT equipment_status_check CHECK (status IN ('available','in_shop','sold','retired','returned_to_vendor'));

CREATE TABLE vendors (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
  phone      TEXT,
  email      TEXT,
  notes      TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_name_key ON vendors(lower(btrim(name)));

-- One row per re-rented machine: who it came from and what it costs Champion.
CREATE TABLE re_rents (
  id               BIGSERIAL PRIMARY KEY,
  equipment_id     BIGINT NOT NULL UNIQUE REFERENCES equipment(id),
  vendor_id        BIGINT NOT NULL REFERENCES vendors(id),
  vendor_agreement TEXT,
  vendor_po        TEXT,
  vendor_unit      TEXT,
  cost_amount      NUMERIC(12,2) NOT NULL CHECK (cost_amount >= 0),
  cost_basis       TEXT NOT NULL CHECK (cost_basis IN ('daily','weekly','cycle_28','monthly')),
  received_date    DATE NOT NULL,
  returned_date    DATE,
  notes            TEXT,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (returned_date IS NULL OR returned_date >= received_date)
);

-- The supplier's invoices for a re-rented machine. Kept permanently; a mistake is voided with a reason.
CREATE TABLE re_rent_bills (
  id             BIGSERIAL PRIMARY KEY,
  re_rent_id     BIGINT NOT NULL REFERENCES re_rents(id),
  vendor_invoice TEXT NOT NULL CHECK (length(btrim(vendor_invoice)) >= 1),
  bill_date      DATE NOT NULL,
  period_start   DATE,
  period_end     DATE,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  notes          TEXT,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at      TIMESTAMPTZ,
  voided_by      BIGINT REFERENCES users(id),
  void_reason    TEXT,
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
  CHECK (voided_at IS NULL OR length(btrim(void_reason)) >= 3)
);
CREATE UNIQUE INDEX re_rent_bills_one_per_invoice ON re_rent_bills(re_rent_id, lower(btrim(vendor_invoice))) WHERE voided_at IS NULL;
CREATE INDEX re_rent_bills_date_idx ON re_rent_bills(bill_date);

CREATE FUNCTION protect_re_rent_bill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Supplier bills cannot be deleted; void it instead'; END IF;
  IF OLD.voided_at IS NOT NULL
     OR NEW.re_rent_id <> OLD.re_rent_id OR NEW.vendor_invoice <> OLD.vendor_invoice OR NEW.bill_date <> OLD.bill_date
     OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.amount <> OLD.amount OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Supplier bills are read-only; void it and enter it again';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER re_rent_bills_protect BEFORE UPDATE OR DELETE ON re_rent_bills
  FOR EACH ROW EXECUTE FUNCTION protect_re_rent_bill();
