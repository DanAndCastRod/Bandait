#!/bin/bash
# Deploy Bandait Leader Web to GitHub Pages
# Usage: bash scripts/deploy-gh-pages.sh

set -e

REPO_URL="https://github.com/danielcastaneda13/Bandait.git"
BUILD_DIR="dist"

echo "Building Bandait Leader Web..."
npm run build

echo "Deploying to GitHub Pages..."
cd "$BUILD_DIR"
git init
git add -A
git commit -m "Deploy Bandait Leader Web $(date)"
git push -f "$REPO_URL" main:gh-pages

echo "Deployed to: https://danielcastaneda13.github.io/Bandait/"
