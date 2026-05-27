#!/bin/bash
# Deploy Bandait Follower PWA to GitHub Pages
# Usage: ./scripts/deploy-gh-pages.sh

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "..")
PWA_DIR="$REPO_ROOT/bandait-follower"
DIST_DIR="$PWA_DIR/dist"

echo "=== Bandait PWA Deploy ==="

# Ensure dist exists
if [ ! -d "$DIST_DIR" ]; then
    echo "ERROR: dist/ not found. Run 'npm run build' first."
    exit 1
fi

# Create gh-pages branch if needed
cd "$REPO_ROOT"
git checkout --orphan gh-pages 2>/dev/null || git checkout gh-pages
git rm -rf .

# Copy dist contents
cp -r "$DIST_DIR"/* .

# Add .nojekyll to bypass Jekyll processing
touch .nojekyll

# Commit and push
git add .
git commit -m "Deploy PWA $(date -u +%Y-%m-%d-%H:%M:%S)"
git push origin gh-pages --force

git checkout main

echo ""
echo "Deployed to: https://<your-username>.github.io/Bandait/"
echo "Update the URL in bandait-protocol/README.md and discovery.py"
