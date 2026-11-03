-- Bulk loading of existing (e.g. Quipli) rentals: upload → preview → create all in one transaction.
CREATE TABLE rental_import_batches (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  filename     TEXT NOT NULL,
  file_sha256  TEXT NOT NULL,
  rows         JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','applied','cancelled')),
  uploaded_by  BIGINT REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by   BIGINT REFERENCES users(id),
  applied_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX rental_import_no_dup_applied ON rental_import_batches(customer_id, file_sha256) WHERE status = 'applied';
