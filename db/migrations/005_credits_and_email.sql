-- Credit memos, and emailing invoices to customers.
-- Credit memos: a numbered, permanent credit against a finalized rental invoice.
-- The original invoice and its PDF never change; its balance goes down by the credit.
-- Adds a table, one column and one invoice status. Existing invoices and amounts are not changed.

ALTER TABLE invoices ADD COLUMN amount_credited NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount_credited >= 0);

ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN
  ('draft','pending_review','rejected','approved','issued','partially_paid','paid','overdue','voided','corrected','credited'));

CREATE TABLE credit_memos (
  id             BIGSERIAL PRIMARY KEY,
  credit_number  TEXT NOT NULL UNIQUE,
  invoice_id     BIGINT NOT NULL REFERENCES invoices(id),
  customer_id    BIGINT NOT NULL REFERENCES customers(id),
  credit_date    DATE NOT NULL,
  reason         TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  subtotal       NUMERIC(14,2) NOT NULL CHECK (subtotal > 0),
  tax_rate       NUMERIC(7,5) NOT NULL,
  tax_amount     NUMERIC(14,2) NOT NULL CHECK (tax_amount >= 0),
  total          NUMERIC(14,2) NOT NULL CHECK (total > 0),
  snapshot       JSONB NOT NULL,
  pdf            BYTEA NOT NULL,
  pdf_sha256     TEXT NOT NULL,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total = subtotal + tax_amount)
);
CREATE INDEX credit_memos_invoice_idx ON credit_memos(invoice_id);
CREATE INDEX credit_memos_customer_idx ON credit_memos(customer_id, credit_date);
-- Issued credits are permanent records, like finalized invoices.
CREATE TRIGGER credit_memos_immutable BEFORE UPDATE OR DELETE ON credit_memos
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────────────────── Emailed invoices ─────────────────────────
-- Where each customer's invoices go (comma-separated), and a permanent log of every send attempt.
ALTER TABLE customer_billing_profiles ADD COLUMN invoice_emails TEXT;

CREATE TABLE document_emails (
  id           BIGSERIAL PRIMARY KEY,
  doc_kind     TEXT NOT NULL CHECK (doc_kind IN ('invoice','credit_memo','sale','statement')),
  doc_id       BIGINT NOT NULL,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  to_addresses TEXT NOT NULL,
  subject      TEXT NOT NULL,
  pdf_sha256   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error        TEXT,
  message_id   TEXT,
  sent_by      BIGINT REFERENCES users(id),
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_emails_doc_idx ON document_emails(doc_kind, doc_id);
CREATE TRIGGER document_emails_append_only BEFORE UPDATE OR DELETE ON document_emails
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
