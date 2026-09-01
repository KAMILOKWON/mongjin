#!/bin/zsh
set -eu

python3 /Volumes/Studio\ ZZG/mongjin/scripts/make_mongjin_appstore_screenshots.py

file \
  "/Volumes/Studio ZZG/mongjin/store/screenshots/mongjin-appstore-01-king-flight-1284x2778.png" \
  "/Volumes/Studio ZZG/mongjin/store/screenshots/mongjin-appstore-02-escort-strategy-1284x2778.png" \
  "/Volumes/Studio ZZG/mongjin/store/screenshots/mongjin-appstore-03-short-deep-match-1284x2778.png"
