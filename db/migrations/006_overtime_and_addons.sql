-- Hour-meter overtime and add-on charges (damage waiver, environmental fee, fuel).
-- Everything here is OFF until a customer's billing profile turns it on. Existing invoices,
-- rates and amounts are not changed. Adds columns and one table.

-- Per-customer settings.
--   Rates cover 8 hours a day, 40 a week and 160 a month (Champion's standard). Each extra hour
--   is billed at (rate / included hours) x overtime_multiplier, e.g. $3,250 / 160 x 1.5.
ALTER TABLE customer_billing_profiles
  ADD COLUMN overtime_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN hours_per_day          NUMERIC(6,1) NOT NULL DEFAULT 8   CHECK (hours_per_day > 0),
  ADD COLUMN hours_per_week         NUMERIC(6,1) NOT NULL DEFAULT 40  CHECK (hours_per_week > 0),
  ADD COLUMN hours_per_month        NUMERIC(6,1) NOT NULL DEFAULT 160 CHECK (hours_per_month > 0),
  ADD COLUMN overtime_multiplier    NUMERIC(5,3) NOT NULL DEFAULT 1.5 CHECK (overtime_multiplier > 0),
  -- Add-ons: NULL means off. Percentages are of the rental charge (e.g. 0.1500 = 15%).
  ADD COLUMN damage_waiver_pct      NUMERIC(6,4) CHECK (damage_waiver_pct > 0 AND damage_waiver_pct < 1),
  ADD COLUMN environmental_pct      NUMERIC(6,4) CHECK (environmental_pct > 0 AND environmental_pct < 1),
  ADD COLUMN fuel_price_per_gallon  NUMERIC(10,4) CHECK (fuel_price_per_gallon > 0);

-- A rental can be excused from the damage waiver (customer carries its own insurance).
ALTER TABLE rental_contract_lines ADD COLUMN damage_waiver_waived BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_kind_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_kind_check CHECK (kind IN
  ('rental','delivery','pickup','fee','adjustment','overtime','damage_waiver','environmental','fuel'));

-- Hour meter readings and fuel for one billing period, one row per unit on site in that period
-- (two rows when the unit was exchanged mid-period). Locked once the period's invoice is approved.
CREATE TABLE period_usage (
  id                BIGSERIAL PRIMARY KEY,
  billing_period_id BIGINT NOT NULL REFERENCES billing_periods(id),
  contract_line_id  BIGINT NOT NULL REFERENCES rental_contract_lines(id),
  equipment_id      BIGINT NOT NULL REFERENCES equipment(id),
  start_hours       NUMERIC(10,1) CHECK (start_hours >= 0),
  end_hours         NUMERIC(10,1) CHECK (end_hours >= 0),
  fuel_gallons      NUMERIC(10,1) NOT NULL DEFAULT 0 CHECK (fuel_gallons >= 0),
  note              TEXT,
  updated_by        BIGINT REFERENCES users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (billing_period_id, equipment_id)
);
CREATE INDEX period_usage_line_idx ON period_usage(contract_line_id);

CREATE FUNCTION protect_finalized_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid BIGINT := COALESCE(OLD.billing_period_id, NEW.billing_period_id);
BEGIN
  IF EXISTS (SELECT 1 FROM invoices WHERE billing_period_id = pid AND finalized_at IS NOT NULL
             AND status NOT IN ('voided','rejected','corrected')) THEN
    RAISE EXCEPTION 'Hour meter readings for an approved invoice cannot be changed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER period_usage_protect BEFORE INSERT OR UPDATE OR DELETE ON period_usage
  FOR EACH ROW EXECUTE FUNCTION protect_finalized_usage();
