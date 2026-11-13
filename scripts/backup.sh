#!/bin/sh
# Backs up every database and all repo files once a day (or when "Back up now" is pressed).
# Keeps the newest 7 of each in the backups folder.
chown 1000:1000 /backups 2>/dev/null
cd /backups || exit 1
while true; do
  due=0
  if [ -f .now ]; then due=1; rm -f .now; fi
  last=$(ls -t db-*.sql.gz 2>/dev/null | head -n 1)
  if [ -z "$last" ] || [ -n "$(find "$last" -mmin +1440 2>/dev/null)" ]; then due=1; fi
  if [ "$due" = 1 ]; then
    ts=$(date +%Y%m%d-%H%M)
    if pg_dumpall -h db -U postgres | gzip > "db-$ts.sql.gz.tmp"; then mv "db-$ts.sql.gz.tmp" "db-$ts.sql.gz"; else rm -f "db-$ts.sql.gz.tmp"; fi
    if tar czf "files-$ts.tar.gz.tmp" -C /data .; then mv "files-$ts.tar.gz.tmp" "files-$ts.tar.gz"; else rm -f "files-$ts.tar.gz.tmp"; fi
    ls -t db-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
    ls -t files-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
    chmod 644 ./*.gz 2>/dev/null
  fi
  sleep 60
done
