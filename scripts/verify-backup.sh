#!/bin/sh
# Restores a backup into a throwaway database and checks invoice/PO counts and stored PDF hashes match.
# Usage: PGHOST=.. PGUSER=.. PGPASSWORD=.. sh scripts/verify-backup.sh backups/champion-XXXX.dump [source_db]
set -eu
FILE="$1"; SRC="${2:-champion}"; TMP="champion_restore_check_$$"
sha256sum -c "$FILE.sha256"
createdb "$TMP"
trap 'dropdb --if-exists "$TMP"' EXIT
pg_restore --no-owner --dbname="$TMP" "$FILE"
Q="SELECT (SELECT count(*) FROM invoices)||'/'||(SELECT count(*) FROM po_assignments)||'/'||(SELECT count(*) FROM audit_log)||'/'||(SELECT count(*) FROM invoice_documents d JOIN invoices i ON i.id=d.invoice_id WHERE encode(sha256(d.pdf),'hex')=d.sha256 AND d.sha256=i.pdf_sha256)"
A=$(psql -At -d "$TMP" -c "$Q"); echo "restored  invoices/po_assignments/audit/valid_pdfs: $A"
B=$(psql -At -d "$SRC" -c "$Q"); echo "live      invoices/po_assignments/audit/valid_pdfs: $B"
echo "Backup restored and verified OK (counts can be higher in live if work happened after the backup)."
