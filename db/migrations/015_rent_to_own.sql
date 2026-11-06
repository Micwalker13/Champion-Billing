-- Rent-to-own (rental purchase option). One option per rental line: a purchase price, the share of
-- rent that counts toward it, and a term in months. Only rent paid on time (within 30 days of the
-- invoice date) counts. Nothing here changes rentals, invoices or amounts; turning an option into a
-- sale is a separate step an employee confirms, which creates a draft equipment sale for review.
CREATE TABLE rental_purchase_options (
  id               BIGSERIAL PRIMARY KEY,
  contract_line_id BIGINT NOT NULL UNIQUE REFERENCES rental_contract_lines(id),
  purchase_price   NUMERIC(14,2) NOT NULL CHECK (purchase_price > 0),
  credit_pct       NUMERIC(5,4) NOT NULL CHECK (credit_pct > 0 AND credit_pct <= 1),
  term_months      INT NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  starts_on        DATE NOT NULL,
  ends_on          DATE NOT NULL CHECK (ends_on > starts_on),
  on_time_days     INT NOT NULL DEFAULT 30 CHECK (on_time_days BETWEEN 0 AND 120),
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exercised','cancelled')),
  sale_id          BIGINT REFERENCES equipment_sales(id),
  credit_at_exercise NUMERIC(14,2),
  cancel_reason    TEXT,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by        BIGINT REFERENCES users(id),
  closed_at        TIMESTAMPTZ,
  CHECK (status <> 'exercised' OR (sale_id IS NOT NULL AND credit_at_exercise IS NOT NULL)),
  CHECK (status <> 'cancelled' OR length(btrim(coalesce(cancel_reason,''))) >= 5)
);
