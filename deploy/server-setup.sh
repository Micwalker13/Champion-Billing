#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 server. Run as root:
#   curl -fsSL <raw URL of this file> | bash      (or copy it over and run: bash server-setup.sh)
set -euo pipefail
DOMAIN="${DOMAIN:?export DOMAIN=billing.yourcompany.com first}"
REPO="${REPO:-git@github.com:Micwalker13/Champion-Billing.git}"
DIR=/opt/champion-billing

apt-get update -y && apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw unattended-upgrades
# Docker Engine + compose plugin
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
# Firewall: SSH + web only (the database is never exposed)
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
dpkg-reconfigure -f noninteractive unattended-upgrades

if [ ! -d "$DIR/.git" ]; then git clone "$REPO" "$DIR"; fi
cd "$DIR"
if [ ! -f .env ]; then
  printf 'DOMAIN=%s\nPOSTGRES_PASSWORD=%s\n' "$DOMAIN" "$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi
mkdir -p backups
docker compose up -d --build
echo
echo "Started. Next: create the first admin user:"
echo "  cd $DIR && docker compose exec app npm run create-user -- you@company.com \"Your Name\" admin"
