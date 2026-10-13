#!/bin/bash
set -e

# ===== ตั้งค่าตรงนี้ =====
SERVER_USER="root"
SERVER_IP="206.189.88.42"          # แก้เป็น IP จริง
SERVER_PATH="/root/www/badminton-service"
PM2_APP="badminton-service"
# =========================

# ===== Deploy จาก branch develop เท่านั้น =====
DEPLOY_BRANCH="develop"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$DEPLOY_BRANCH" ]; then
  echo "❌ Deploy ได้จาก branch \"$DEPLOY_BRANCH\" เท่านั้น (ตอนนี้อยู่ที่ \"$CURRENT_BRANCH\")"
  echo "   git checkout $DEPLOY_BRANCH แล้วลองใหม่"
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "⚠️  มีไฟล์ที่ยังไม่ได้ commit — ไฟล์เหล่านี้จะถูก deploy ไปด้วย:"
  git status --short --untracked-files=no
fi

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
ssh "$SERVER_USER@$SERVER_IP" << 'ENDSSH'
  # โหลด nvm ถ้ามี
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

  # หา pm2 path
  PM2=$(which pm2 2>/dev/null || echo "")
  if [ -z "$PM2" ]; then
    echo "❌ pm2 not found! Please install: npm install -g pm2"
    exit 1
  fi
  echo "✅ Found pm2 at: $PM2"

  cd /root/www/badminton-service
  npm install --omit=dev
  $PM2 reload badminton-service || $PM2 start ecosystem.config.js --env production
  $PM2 save
  $PM2 status
ENDSSH

echo "✅ Deploy complete!"
