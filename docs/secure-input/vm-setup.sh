#!/usr/bin/env bash
# VM Setup Script for OpenClaw Secure Secret Feature Testing
# Run this inside a fresh Ubuntu 24.04 VM
set -euo pipefail

echo "=== OpenClaw VM Test Setup ==="
echo ""

# 1. System dependencies
echo "[1/5] Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq git curl build-essential

# 2. Node.js 22 via NodeSource
echo "[2/5] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y -qq nodejs

# 3. pnpm via corepack
echo "[3/5] Enabling pnpm via corepack..."
sudo corepack enable
corepack prepare pnpm@10.23.0 --activate

# 4. Clone fork and checkout branch
echo "[4/5] Cloning openclaw fork..."
if [ ! -d "$HOME/openclaw" ]; then
  git clone --branch feat/secret-command https://github.com/divanoli/openclaw.git "$HOME/openclaw"
else
  echo "  Already cloned, pulling latest..."
  cd "$HOME/openclaw"
  git fetch origin
  git checkout feat/secret-command
  git pull origin feat/secret-command
fi

# 5. Install dependencies
echo "[5/5] Installing project dependencies..."
cd "$HOME/openclaw"
pnpm install --frozen-lockfile

echo ""
echo "=== Setup complete ==="
echo "Node: $(node -v)"
echo "pnpm: $(pnpm -v)"
echo "Branch: $(git branch --show-current)"
echo ""
echo "Next: run the test script"
echo "  bash docs/secure-input/vm-test.sh"
