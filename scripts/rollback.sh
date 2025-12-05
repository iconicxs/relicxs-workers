#!/bin/bash
set -e

echo "⏪ Rolling back to previous commit..."
git reset --hard HEAD~1
git pull

npm install --production

pm2 reload pm2/ecosystem.config.js
pm2 status
