-- Credit limits and credit holds on customers. Two new columns, both empty/off by default, so nothing
-- changes for any customer until someone sets a limit or a hold. No invoice or amount is touched.
ALTER TABLE customers
  ADD COLUMN credit_limit NUMERIC(12,2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  ADD COLUMN credit_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN credit_note TEXT;
