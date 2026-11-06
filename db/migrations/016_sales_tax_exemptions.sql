-- Sales tax exemptions: agricultural (ag/timber number), resale, interstate. One row per certificate
-- on a customer, for the whole customer or one rental contract (often the case for interstate).
-- While a certificate covers a billing period's start date, that invoice charges no sales tax.
-- Equipment fees (HET, TERP, surcharges) are not sales tax and keep their own exemptions.
-- Finalized invoices never change; only drafts and new invoices pick this up.
CREATE TABLE sales_tax_exemptions (
  id                 BIGSERIAL PRIMARY KEY,
  customer_id        BIGINT NOT NULL REFERENCES customers(id),
  contract_id        BIGINT REFERENCES rental_contracts(id),
  reason             TEXT NOT NULL CHECK (reason IN ('agricultural','resale','interstate')),
  certificate_number TEXT,
  effective_from     DATE NOT NULL,
  effective_to       DATE,
  notes              TEXT,
  file_name          TEXT,
  file_mime          TEXT,
  file_content       BYTEA,
  created_by         BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at         TIMESTAMPTZ,
  removed_by         BIGINT REFERENCES users(id),
  removed_reason     TEXT,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (certificate_number IS NOT NULL OR file_content IS NOT NULL),
  CHECK (removed_at IS NULL OR length(btrim(coalesce(removed_reason,''))) >= 3)
);
CREATE INDEX sales_tax_exemptions_customer_idx ON sales_tax_exemptions(customer_id) WHERE removed_at IS NULL;
