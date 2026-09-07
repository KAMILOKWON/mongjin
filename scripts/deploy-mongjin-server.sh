#!/usr/bin/env bash
set -euo pipefail
# The release CLI checks clean Git state and explicit production approval.
# Commit with [skip ci] so server-only releases do not publish GitHub Pages.
git log -1 --format=%B | grep -Fq '[skip ci]' || { echo 'Server release commit requires [skip ci]'; exit 1; }
git push origin HEAD:main
gh workflow run deploy-server.yml --ref main --repo KAMILOKWON/mongjin
