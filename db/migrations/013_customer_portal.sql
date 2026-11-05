-- Customer portal: customers' own people sign in with an emailed link to see their rentals and
-- invoices and send requests. New tables only. Nothing here changes rentals, invoices or amounts,
-- and every portal request is handled by an employee.

CREATE TABLE portal_users (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  email         TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%._%'),
  name          TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  invited_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
-- One login per email address, so an address can never see two customers.
CREATE UNIQUE INDEX portal_users_email_key ON portal_users(email);
CREATE INDEX portal_users_customer_idx ON portal_users(customer_id);

-- One-time sign-in links. Only a hash of the token is stored.
CREATE TABLE portal_login_tokens (
  id             BIGSERIAL PRIMARY KEY,
  portal_user_id BIGINT NOT NULL REFERENCES portal_users(id),
  token_hash     TEXT NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX portal_login_tokens_user_idx ON portal_login_tokens(portal_user_id, created_at);

CREATE TABLE portal_sessions (
  token_hash     TEXT PRIMARY KEY,
  portal_user_id BIGINT NOT NULL REFERENCES portal_users(id),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What a customer asks for. An employee reviews every one; nothing is automatic.
CREATE TABLE portal_requests (
  id               BIGSERIAL PRIMARY KEY,
  customer_id      BIGINT NOT NULL REFERENCES customers(id),
  portal_user_id   BIGINT NOT NULL REFERENCES portal_users(id),
  kind             TEXT NOT NULL CHECK (kind IN ('pickup','extension','coi','question')),
  contract_line_id BIGINT REFERENCES rental_contract_lines(id),
  requested_date   DATE,
  message          TEXT,
  file_name        TEXT,
  file_mime        TEXT,
  file_content     BYTEA,
  coi_insurer      TEXT,
  coi_policy       TEXT,
  coi_effective_on DATE,
  coi_expires_on   DATE,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','declined')),
  response         TEXT,
  handled_by       BIGINT REFERENCES users(id),
  handled_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('pickup','extension') OR contract_line_id IS NOT NULL),
  CHECK (kind <> 'coi' OR file_content IS NOT NULL),
  CHECK (status = 'open' OR handled_at IS NOT NULL)
);
CREATE INDEX portal_requests_open_idx ON portal_requests(created_at) WHERE status = 'open';
CREATE INDEX portal_requests_customer_idx ON portal_requests(customer_id, created_at DESC);
