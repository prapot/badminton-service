#!/bin/bash
# ─────────────────────────────────────────────
#  deploy.sh  —  Strapi (badminton-service)
#  รันบน server: bash deploy.sh
# ─────────────────────────────────────────────

set -e  # หยุดทันทีถ้ามี error

APP_DIR="/root/www/badminton-service"
LOG_DIR="/var/log/pm2"
PM2_NAME="badminton-service"

echo "🚀 Starting deploy: $PM2_NAME"
echo "📁 Directory: $APP_DIR"

# ── 1. Pull latest code ──────────────────────
cd "$APP_DIR"
echo "📥 Pulling latest code..."
git pull origin main

# ── 2. Install dependencies ─────────────────
echo "📦 Installing dependencies..."
npm install --omit=dev

# ── 3. Copy .env.production → .env ──────────
if [ -f ".env.production" ]; then
    echo "⚙️  Applying .env.production..."
    cp .env.production .env
fi

# ── 4. Build Strapi ──────────────────────────
echo "🔨 Building Strapi..."
NODE_ENV=production npm run build

# ── 5. Create log dir if missing ────────────
mkdir -p "$LOG_DIR"

# ── 6. PM2 restart or start ─────────────────
echo "⚡ Starting/restarting PM2..."
if pm2 describe "$PM2_NAME" > /dev/null 2>&1; then
    pm2 restart "$PM2_NAME"
else
    pm2 start ecosystem.config.js
fi

pm2 save

echo "✅ Deploy complete! Checking status..."
pm2 status "$PM2_NAME"
