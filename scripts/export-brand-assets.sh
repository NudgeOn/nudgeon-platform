#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert is required (librsvg)." >&2; exit 1; }
rsvg-convert -w 1600 docs-public/assets/nudgeon-logo.svg -o docs-public/assets/nudgeon-logo.png
cp docs-public/assets/nudgeon-logo.png apps/docs-site/public/assets/nudgeon-logo.png
cp docs-public/assets/nudgeon-mark.svg apps/docs-site/public/assets/nudgeon-mark.svg
cp docs-public/assets/nudgeon-mark.svg apps/marketing-site/public/assets/nudgeon-mark.svg
cp docs-public/assets/nudgeon-mark.svg apps/console/src/app/icon.svg
cp docs-public/assets/nudgeon-logo.png apps/marketing-site/public/assets/nudgeon-lockup.png
rsvg-convert -w 1024 -h 1024 docs-public/assets/nudgeon-mark.svg -o apps/marketing-site/public/assets/nudgeon-avatar.png
for lang in en ko; do
  rsvg-convert "apps/marketing-site/public/assets/og-${lang}.svg" -o "apps/marketing-site/public/assets/og-${lang}.png"
done
