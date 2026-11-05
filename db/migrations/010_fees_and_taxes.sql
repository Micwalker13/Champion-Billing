-- Configurable equipment fees and taxes (HET, TERP, environmental, custom surcharges).
-- Additive only: new tables, one new equipment column, and new nullable columns on invoice_lines.
-- No rates are built in: every fee, its rate and which equipment it applies to is entered by an administrator.

ALTER TABLE equipment ADD COLUMN equipment_class TEXT;

-- One row per fee or tax. category keeps government-required taxes apart from Champion's own surcharges.
CREATE TABLE fee_types (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name            TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
  description     TEXT,
  category        TEXT NOT NULL CHECK (category IN ('regulatory_tax','business_surcharge')),
  calc_type       TEXT NOT NULL CHECK (calc_type IN ('percent','fixed')),
  frequency       TEXT NOT NULL CHECK (frequency IN ('per_billing_cycle','one_time')),
  applies_rentals BOOLEAN NOT NULL DEFAULT TRUE,   -- rental quotes, rental contracts and their invoices
  applies_sales   BOOLEAN NOT NULL DEFAULT FALSE,  -- equipment sales
  taxable         BOOLEAN NOT NULL DEFAULT FALSE,  -- whether sales tax is charged on the fee itself
  gl_account      TEXT,                            -- accounting code, for the export
  allow_override  BOOLEAN NOT NULL DEFAULT TRUE,   -- whether approvers may change or waive it on one rental or sale
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (applies_rentals OR applies_sales)
);

-- Rate history. The rate in force on a billing period's first day (or a sale's date) is used.
-- effective_to NULL means open-ended. Rows are never edited; a new rate gets a new row.
CREATE TABLE fee_rates (
  id             BIGSERIAL PRIMARY KEY,
  fee_type_id    BIGINT NOT NULL REFERENCES fee_types(id),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  percent        NUMERIC(9,6) CHECK (percent IS NULL OR (percent > 0 AND percent < 1)),   -- 0.020000 = 2%
  amount         NUMERIC(12,2) CHECK (amount IS NULL OR amount > 0),
  note           TEXT,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((percent IS NULL) <> (amount IS NULL)),
  EXCLUDE USING gist (fee_type_id WITH =, daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&)
);
-- Rates are history: never deleted, and the only allowed change is giving an open-ended rate its end date
-- (done automatically when a newer rate is added).
CREATE FUNCTION protect_fee_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Fee rates are kept as history and cannot be deleted.'; END IF;
  IF OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL
     OR NEW.fee_type_id <> OLD.fee_type_id OR NEW.effective_from <> OLD.effective_from
     OR NEW.percent IS DISTINCT FROM OLD.percent OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Fee rates are kept as history. Add a new rate with its start date instead of changing an old one.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fee_rates_protect BEFORE UPDATE OR DELETE ON fee_rates FOR EACH ROW EXECUTE FUNCTION protect_fee_rate();

-- Which equipment a fee applies to: a whole equipment class, a product category, or (explicitly) all equipment.
-- Single units are switched on or off in equipment_fee_settings.
CREATE TABLE fee_assignments (
  id               BIGSERIAL PRIMARY KEY,
  fee_type_id      BIGINT NOT NULL REFERENCES fee_types(id),
  scope            TEXT NOT NULL CHECK (scope IN ('class','category','all')),
  equipment_class  TEXT,
  category         TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'class') = (equipment_class IS NOT NULL)),
  CHECK ((scope = 'category') = (category IS NOT NULL))
);
CREATE UNIQUE INDEX fee_assignments_one_active ON fee_assignments(fee_type_id, scope, COALESCE(equipment_class, ''), COALESCE(category, '')) WHERE active;

-- Per-unit switch. enabled=true applies the fee to this unit even without a class/category match;
-- enabled=false keeps it off this unit even when its class or category matches.
CREATE TABLE equipment_fee_settings (
  equipment_id  BIGINT NOT NULL REFERENCES equipment(id),
  fee_type_id   BIGINT NOT NULL REFERENCES fee_types(id),
  enabled       BOOLEAN NOT NULL,
  reason        TEXT,
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (equipment_id, fee_type_id)
);

-- Customer exemptions (e.g. a tax exemption certificate). Never deleted; ended or removed with a reason.
CREATE TABLE fee_exemptions (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  fee_type_id     BIGINT NOT NULL REFERENCES fee_types(id),
  reason          TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
  certificate_ref TEXT,
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at      TIMESTAMPTZ,
  removed_by      BIGINT REFERENCES users(id),
  removed_reason  TEXT,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX fee_exemptions_customer_idx ON fee_exemptions(customer_id) WHERE removed_at IS NULL;

-- An approver's override of one fee on one rental line or one sale: a different rate, or waived.
CREATE TABLE fee_overrides (
  id               BIGSERIAL PRIMARY KEY,
  fee_type_id      BIGINT NOT NULL REFERENCES fee_types(id),
  contract_line_id BIGINT REFERENCES rental_contract_lines(id),
  sale_id          BIGINT REFERENCES equipment_sales(id),
  waived           BOOLEAN NOT NULL DEFAULT FALSE,
  percent          NUMERIC(9,6) CHECK (percent IS NULL OR (percent > 0 AND percent < 1)),
  amount           NUMERIC(12,2) CHECK (amount IS NULL OR amount >= 0),
  reason           TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  created_by       BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at       TIMESTAMPTZ,
  removed_by       BIGINT REFERENCES users(id),
  CHECK ((contract_line_id IS NULL) <> (sale_id IS NULL)),
  CHECK (waived OR (percent IS NULL) <> (amount IS NULL))
);
CREATE UNIQUE INDEX fee_overrides_one_line ON fee_overrides(fee_type_id, contract_line_id) WHERE removed_at IS NULL AND contract_line_id IS NOT NULL;
CREATE UNIQUE INDEX fee_overrides_one_sale ON fee_overrides(fee_type_id, sale_id) WHERE removed_at IS NULL AND sale_id IS NOT NULL;

-- Invoice lines remember which fee produced them and its accounting class, for reporting.
ALTER TABLE invoice_lines
  ADD COLUMN fee_type_id  BIGINT REFERENCES fee_types(id),
  ADD COLUMN fee_category TEXT CHECK (fee_category IS NULL OR fee_category IN ('regulatory_tax','business_surcharge'));
ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_kind_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_kind_check CHECK (kind IN
  ('rental','delivery','pickup','fee','adjustment','overtime','damage_waiver','environmental','fuel','equipment_fee'));
CREATE INDEX invoice_lines_fee_type_idx ON invoice_lines(fee_type_id) WHERE fee_type_id IS NOT NULL;

-- Fees on an equipment sale, worked out while the sale is a draft and frozen when it is finalized.
CREATE TABLE sale_fees (
  id           BIGSERIAL PRIMARY KEY,
  sale_id      BIGINT NOT NULL REFERENCES equipment_sales(id),
  fee_type_id  BIGINT NOT NULL REFERENCES fee_types(id),
  fee_category TEXT NOT NULL CHECK (fee_category IN ('regulatory_tax','business_surcharge')),
  description  TEXT NOT NULL,
  amount       NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  taxable      BOOLEAN NOT NULL,
  UNIQUE (sale_id, fee_type_id)
);
CREATE FUNCTION protect_finalized_sale_fees() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM equipment_sales WHERE id = COALESCE(NEW.sale_id, OLD.sale_id) AND finalized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'This sale is finalized; its fees cannot change';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER sale_fees_protect BEFORE INSERT OR UPDATE OR DELETE ON sale_fees FOR EACH ROW EXECUTE FUNCTION protect_finalized_sale_fees();
