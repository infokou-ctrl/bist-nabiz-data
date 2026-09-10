#!/usr/bin/env bash
# Cron'u duraklat: data/PAUSE oluştur + commit + push. Bu dosya varken hafta içi
# otomatik yenileme koşuları KENDİLİĞİNDEN atlanır (elle "Run workflow" yine çalışır).
# Yerelde veri üretip commit'lerken bot'un araya girip çakışma yaratmasını önler.
set -e
cd "$(dirname "$0")"
git pull --rebase --autostash origin main
date -u +"%Y-%m-%dT%H:%MZ · manuel çalışma" > data/PAUSE
git add data/PAUSE
git commit -m "cron: duraklat (manuel çalışma)"
git push
echo "⏸  Cron duraklatıldı. Bitince: ./cron-resume.sh"
