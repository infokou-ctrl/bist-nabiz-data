#!/usr/bin/env bash
# Cron'u yeniden başlat: data/PAUSE'u sil + commit + push.
set -e
cd "$(dirname "$0")"
git pull --rebase --autostash origin main
rm -f data/PAUSE
git add -A data/PAUSE
git commit -m "cron: devam et"
git push
echo "▶  Cron yeniden aktif."
