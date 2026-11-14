#!/bin/sh
# Checks GitHub every 5 minutes (from cron). When there are new files it rebuilds the app.
# If a build fails, the old app keeps running. The result shows in Fit-Rend-Base under Admin > Settings.
cd /opt/fit-rend-base || exit 0
mkdir -p state
[ -f state/.lock ] && [ -z "$(find state/.lock -mmin +30)" ] && exit 0
touch state/.lock
trap 'rm -f state/.lock' EXIT
# When the Caddyfile changes (for example the DNS room's free https for your own domains),
# check it first, then restart only Caddy so it reads the new file.
caddy_sync() {
  sum=$(sha256sum Caddyfile 2>/dev/null | cut -d' ' -f1)
  [ -z "$sum" ] && return 0
  [ "$sum" = "$(cat state/caddy.sum 2>/dev/null)" ] && return 0
  if docker compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > state/caddy.log 2>&1; then
    docker compose up -d --force-recreate caddy >> state/caddy.log 2>&1 && echo "$sum" > state/caddy.sum
  else
    echo "$(date -u) Caddyfile has a mistake, kept the old one running" >> state/caddy.log
    echo "$sum" > state/caddy.sum
  fi
}
caddy_sync
git fetch -q origin || { echo "$(date -u) could not reach GitHub" > state/update.txt; exit 0; }
branch=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
new=$(git rev-parse "$branch")
[ "$new" = "$(cat state/built 2>/dev/null)" ] && exit 0
if [ "$new" = "$(cat state/failed 2>/dev/null)" ] && [ -z "$(find state/failed -mmin +60)" ]; then exit 0; fi
git reset -q --hard "$new"
if docker compose build app > state/build.log 2>&1 && docker compose up -d >> state/build.log 2>&1; then
  echo "$new" > state/built; rm -f state/failed
  caddy_sync
  echo "$(date -u) updated OK to $(git log -1 --format='%h %s')" > state/update.txt
else
  echo "$new" > state/failed
  { echo "$(date -u) update FAILED for $(git log -1 --format='%h %s'). The old version is still running."; tail -n 40 state/build.log; } > state/update.txt
fi
