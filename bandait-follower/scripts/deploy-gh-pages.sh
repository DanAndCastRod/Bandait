#!/bin/bash
# Deploy Bandait Follower PWA to GitHub Pages
# Usage: bash scripts/deploy-gh-pages.sh

set -e

REPO_URL="https://github.com/danielcastaneda13/Bandait.git"
BUILD_DIR="dist"

echo "Building Bandait Follower PWA..."
npm run build

echo "Deploying to GitHub Pages..."
cd "$BUILD_DIR"
git init
git add -A
git commit -m "Deploy Bandait Follower PWA $(date)"
git push -f "$REPO_URL" main:gh-pages-follower

echo "Deployed to: https://danielcastaneda13.github.io/Bandait/follower/"
