#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Synthony Cue System..."
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Install with:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  read -p "Press any key to exit..."
  exit 1
fi
if [ ! -d "node_modules" ]; then
  # --omit=dev skips electron/electron-builder, which are not used on the Pi
  echo "Installing dependencies..."
  npm install --omit=dev
fi
node server.js
read -p "Press any key to exit..."
