-- Shop work orders (parts, labor, outside repair) and service-due reminders by hour meter or date.
-- New tables only, plus one optional link from a rental fee to the work order it bills.
-- Existing rentals, invoices and amounts are not changed.

CREATE TABLE work_orders (
  id               BIGSERIAL PRIMARY KEY,
  wo_number        TEXT NOT NULL UNIQUE,
  equipment_id     BIGINT NOT NULL REFERENCES equipment(id),
  opened_on        DATE NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'repair' CHECK (kind IN ('repair','service','inspection','make_ready','damage')),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting_parts','completed','cancelled')),
  complaint        TEXT NOT NULL CHECK (length(btrim(complaint)) >= 3),
  cause            TEXT,
  correction       TEXT,
  hours_in         NUMERIC(10,1) CHECK (hours_in >= 0),
  assigned_to      TEXT,
  -- Damage found on return can be billed back to the renter as a one-time charge on that rental.
  contract_line_id BIGINT REFERENCES rental_contract_lines(id),
  billed_fee_id    BIGINT REFERENCES contract_line_fees(id),
  service_interval_id BIGINT,
  completed_on     DATE,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR completed_on IS NOT NULL)
);
CREATE INDEX work_orders_equipment_idx ON work_orders(equipment_id, opened_on DESC);
CREATE INDEX work_orders_open_idx ON work_orders(status) WHERE status NOT IN ('completed','cancelled');

CREATE TABLE work_order_lines (
  id            BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES work_orders(id),
  kind          TEXT NOT NULL CHECK (kind IN ('part','labor','outside')),
  description   TEXT NOT NULL CHECK (length(btrim(description)) >= 2),
  part_number   TEXT,
  quantity      NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  unit_cost     NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),
  amount        NUMERIC(14,2) NOT NULL,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount = round(quantity * unit_cost, 2))
);
CREATE INDEX work_order_lines_wo_idx ON work_order_lines(work_order_id);

-- Lines on a completed or cancelled work order can't change.
CREATE FUNCTION protect_closed_work_order_lines() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM work_orders WHERE id = COALESCE(NEW.work_order_id, OLD.work_order_id) AND status IN ('completed','cancelled')) THEN
    RAISE EXCEPTION 'This work order is closed; its parts and labor cannot be changed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER work_order_lines_protect BEFORE INSERT OR UPDATE OR DELETE ON work_order_lines
  FOR EACH ROW EXECUTE FUNCTION protect_closed_work_order_lines();

-- Recurring service on a unit, e.g. "250-hour service" every 250 hours or "Annual inspection" every 365 days.
CREATE TABLE service_intervals (
  id              BIGSERIAL PRIMARY KEY,
  equipment_id    BIGINT NOT NULL REFERENCES equipment(id),
  name            TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
  every_hours     NUMERIC(8,1) CHECK (every_hours > 0),
  every_days      INT CHECK (every_days > 0),
  last_done_hours NUMERIC(10,1) CHECK (last_done_hours >= 0),
  last_done_on    DATE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (every_hours IS NOT NULL OR every_days IS NOT NULL),
  UNIQUE (equipment_id, name)
);
ALTER TABLE work_orders ADD CONSTRAINT work_orders_interval_fk FOREIGN KEY (service_interval_id) REFERENCES service_intervals(id);

-- Each unit's history also shows shop visits.
ALTER TABLE equipment_events DROP CONSTRAINT equipment_events_kind_check;
ALTER TABLE equipment_events ADD CONSTRAINT equipment_events_kind_check CHECK (kind IN
  ('added','moved','status','hours','exchange_out','exchange_in','returned','sold','sale_voided','work_order','service_done'));
ALTER TABLE equipment_events ADD COLUMN work_order_id BIGINT REFERENCES work_orders(id);

ALTER TABLE company_settings ADD COLUMN next_work_order_number INT NOT NULL DEFAULT 1001 CHECK (next_work_order_number > 0);
