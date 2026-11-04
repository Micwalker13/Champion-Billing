#!/usr/bin/env bash
# Off-site backup for a hosted database (Supabase). Used by .github/workflows/backup.yml.
# 1. Dumps the app's tables (schema "public").
# 2. Proves the dump restores: loads it into an empty database and checks the stored invoice
#    PDFs still match their SHA-256 hashes.
# 3. Encrypts it with BACKUP_PASSPHRASE (AES-256, PBKDF2). Only the encrypted file is kept.
#
# Env: BACKUP_DATABASE_URL  source database (Supabase "Session pooler" connection string)
#      BACKUP_PASSPHRASE    encryption passphrase (keep a copy somewhere safe: without it the backup is useless)
#      RESTORE_CHECK_URL    an empty scratch database for the restore test
#      DATABASE_CA_CERT     optional: Supabase root certificate (PEM) for verified TLS
#      OUT_DIR              optional, default ./backup-out
set -euo pipefail
: "${BACKUP_DATABASE_URL:?}" "${BACKUP_PASSPHRASE:?}" "${RESTORE_CHECK_URL:?}"
OUT_DIR="${OUT_DIR:-backup-out}"
mkdir -p "$OUT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP="$OUT_DIR/champion-billing-$STAMP.dump"

if [ -n "${DATABASE_CA_CERT:-}" ]; then
  CA="$(mktemp)"; printf '%b\n' "$DATABASE_CA_CERT" > "$CA"
  export PGSSLROOTCERT="$CA" PGSSLMODE=verify-full
elif [[ "$BACKUP_DATABASE_URL" != *sslmode=* && "$BACKUP_DATABASE_URL" != *localhost* && "$BACKUP_DATABASE_URL" != *127.0.0.1* ]]; then
  export PGSSLMODE=require
fi

pg_dump "$BACKUP_DATABASE_URL" --format=custom --no-owner --no-privileges --schema=public --file="$DUMP"
unset PGSSLMODE PGSSLROOTCERT

# Restore test into the scratch database.
# Extensions live outside "public" so the dump's own CREATE SCHEMA public (if any) can run.
CREATE_PUBLIC="CREATE SCHEMA public;"
pg_restore --list "$DUMP" | grep -q "SCHEMA - public" && CREATE_PUBLIC=""
psql -q "$RESTORE_CHECK_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; $CREATE_PUBLIC
  CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_CHECK_URL" "$DUMP"
COUNTS=$(psql -At "$RESTORE_CHECK_URL" -v ON_ERROR_STOP=1 -c "
  SELECT (SELECT count(*) FROM invoices) || ' invoices, ' ||
         (SELECT count(*) FROM po_assignments) || ' PO assignments, ' ||
         (SELECT count(*) FROM audit_log) || ' audit entries, ' ||
         (SELECT count(*) FROM invoice_documents) || ' finalized PDFs, ' ||
         (SELECT count(*) FROM invoice_documents WHERE encode(sha256(pdf),'hex') <> sha256) || ' damaged PDFs'")
echo "Restore test: $COUNTS"
[[ "$COUNTS" == *" 0 damaged PDFs" ]] || { echo "A restored invoice PDF does not match its hash." >&2; exit 1; }

openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$DUMP" -out "$DUMP.enc" -pass env:BACKUP_PASSPHRASE
rm -f "$DUMP"
(cd "$OUT_DIR" && sha256sum "$(basename "$DUMP.enc")" > "$(basename "$DUMP.enc").sha256")
echo "Encrypted backup: $DUMP.enc ($(du -h "$DUMP.enc" | cut -f1))"
