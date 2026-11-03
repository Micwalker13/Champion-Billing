#!/bin/sh
# Nightly logical backup (custom format) with retention. Uses PG* environment variables.
set -eu
DIR="${1:-./backups}"; KEEP="${KEEP_DAYS:-35}"
mkdir -p "$DIR"
FILE="$DIR/champion-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --file="$FILE.partial"
mv "$FILE.partial" "$FILE"
sha256sum "$FILE" > "$FILE.sha256"
find "$DIR" -name 'champion-*.dump*' -mtime +"$KEEP" -delete
echo "backup written: $FILE"
