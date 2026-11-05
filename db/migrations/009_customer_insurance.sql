-- Certificates of insurance (COI) and the damage waiver choice for each customer.
-- Additive only: one new column on customer_billing_profiles and one new table. No existing data changes.

-- 'rdw'  = the customer buys Champion's damage waiver (billed at damage_waiver_pct of rental).
-- 'coi'  = the customer insures the equipment themselves. The waiver is skipped only while a
--          certificate on file covers the whole billing period; otherwise it is billed.
ALTER TABLE customer_billing_profiles
  ADD COLUMN rdw_choice TEXT NOT NULL DEFAULT 'rdw' CHECK (rdw_choice IN ('rdw','coi'));

CREATE TABLE customer_insurance_certificates (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  insurer         TEXT NOT NULL,
  policy_number   TEXT,
  effective_on    DATE NOT NULL,
  expires_on      DATE NOT NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  content         BYTEA NOT NULL,
  sha256          TEXT NOT NULL,
  uploaded_by     BIGINT REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at      TIMESTAMPTZ,
  removed_by      BIGINT REFERENCES users(id),
  removed_reason  TEXT,
  CHECK (expires_on >= effective_on),
  CHECK (removed_at IS NULL OR (removed_by IS NOT NULL AND length(trim(removed_reason)) > 0))
);
CREATE INDEX customer_insurance_certificates_customer_idx ON customer_insurance_certificates(customer_id, expires_on);

-- A certificate is a record: its file and dates never change and it is never deleted.
-- The only allowed change is marking it removed (once), with who and why.
CREATE FUNCTION protect_insurance_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Insurance certificates cannot be deleted; mark them removed instead.';
  END IF;
  IF OLD.removed_at IS NOT NULL
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.insurer IS DISTINCT FROM OLD.insurer
     OR NEW.policy_number IS DISTINCT FROM OLD.policy_number OR NEW.effective_on IS DISTINCT FROM OLD.effective_on
     OR NEW.expires_on IS DISTINCT FROM OLD.expires_on OR NEW.filename IS DISTINCT FROM OLD.filename
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
    RAISE EXCEPTION 'Insurance certificates are read-only once uploaded. Upload a new certificate instead.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_insurance_certificates_protect BEFORE UPDATE OR DELETE ON customer_insurance_certificates
  FOR EACH ROW EXECUTE FUNCTION protect_insurance_certificate();
