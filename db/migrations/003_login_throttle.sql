-- Failed sign-ins are kept in the database so the 5-per-15-minutes limit holds across
-- all server instances (Vercel runs several), not just within one process.
CREATE TABLE login_failures (
  id        BIGSERIAL PRIMARY KEY,
  email     TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_email_time ON login_failures (email, failed_at);
