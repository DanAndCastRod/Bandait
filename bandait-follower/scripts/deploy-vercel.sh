#!/bin/bash
# Deploy Bandait Follower PWA to Vercel (alternative to GitHub Pages)
# Requires: npm i -g vercel
# Usage: ./scripts/deploy-vercel.sh

set -e

PWA_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Bandait PWA Deploy to Vercel ==="

cd "$PWA_DIR"

# Ensure dist exists
if [ ! -d "dist" ]; then
    echo "ERROR: dist/ not found. Run 'npm run build' first."
    exit 1
fi

# Deploy using Vercel CLI
vercel --prod --yes dist/

echo ""
echo "Deployed! Check Vercel dashboard for URL."
