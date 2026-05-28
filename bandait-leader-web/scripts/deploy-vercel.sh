#!/bin/bash
# Deploy Bandait Leader Web to Vercel
# Usage: bash scripts/deploy-vercel.sh
# Requires: npm i -g vercel

set -e

echo "Building Bandait Leader Web..."
npm run build

echo "Deploying to Vercel..."
cd dist
vercel --prod

echo "Deployment complete!"
