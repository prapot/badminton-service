#!/bin/bash
set -e

# ===== ตั้งค่าตรงนี้ =====
SERVER_USER="root"
SERVER_IP="206.189.88.42"          # แก้เป็น IP จริง
SERVER_PATH="/root/www/badminton-service"
PM2_APP="badminton-service"
# =========================

echo "🔨 Building admin panel locally..."
NODE_ENV=production npm run build

echo "📦 Syncing files to server..."
rsync -avz --progress \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.tmp' \
  --exclude='.env' \
  --exclude='data' \
  ./ "$SERVER_USER@$SERVER_IP:$SERVER_PATH/"

echo "🚀 Installing deps & reloading PM2 on server..."
ssh "$SERVER_USER@$SERVER_IP" << EOF
  cd $SERVER_PATH
  npm install --omit=dev
  pm2 reload $PM2_APP
  pm2 status
EOF

echo "✅ Deploy complete!"
