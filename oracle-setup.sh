#!/bin/bash
# Fit-Rend-Base: one-time setup for a fresh Oracle Cloud Ubuntu server.
# Paste this whole file into "Initialization script" when you create the server.
# Change only the two lines below.
GITHUB_TOKEN="PASTE_YOUR_READ_ONLY_GITHUB_TOKEN_HERE"
GITHUB_REPO="messagerangelhelper-code/fit-rend-base"

set -e
exec > /var/log/fit-rend-base-setup.log 2>&1
DIR=/opt/fit-rend-base
export DEBIAN_FRONTEND=noninteractive

# 1. Open web ports 80 and 443 in the server's own firewall (saved before Docker adds its own rules)
apt-get update -y
apt-get install -y git curl iptables-persistent
for p in 443 80; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport $p -j ACCEPT
done
netfilter-persistent save || true

# 2. Docker and Docker Compose
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker

# 3. Get the app from your private GitHub repo (the token can only read that one repo)
umask 077
printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > /root/.git-credentials
umask 022
git config --global credential.helper store
git config --global --add safe.directory $DIR
if [ ! -d $DIR/.git ]; then git clone "https://github.com/$GITHUB_REPO.git" $DIR; fi
cd $DIR
mkdir -p state

# 4. Secret settings, made once and kept on this server only
if [ ! -f .env ]; then
  IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
  umask 077
  cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_SECRET=$(openssl rand -hex 32)
DOMAIN=${IP//./-}.sslip.io
KEEPALIVE_CPU=0.5
ENV
  umask 022
fi

# 5. Start everything
docker compose up -d --build
git rev-parse HEAD > state/built
echo "$(date -u) first install OK" > state/update.txt

# 6. Check GitHub for new files every 5 minutes and update by itself
echo "*/5 * * * * root sh $DIR/scripts/update.sh >/dev/null 2>&1" > /etc/cron.d/fit-rend-base
chmod 644 /etc/cron.d/fit-rend-base

echo "DONE. Open https://$(grep DOMAIN .env | cut -d= -f2)" | tee $DIR/state/address.txt
