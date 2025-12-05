#!/bin/bash
set -e

echo "🔄 Pulling latest code..."
git pull origin main

echo "📦 Installing dependencies..."
npm install --production

echo "🔍 Validating environment..."
if [ ! -f ".env" ]; then
	echo "❌ Missing .env file"
	exit 1
fi

echo "🚀 Reloading PM2 processes..."
pm2 reload pm2/ecosystem.config.js

echo "✨ Deployment complete!"
pm2 status
