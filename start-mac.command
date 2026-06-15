#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Synthony Cue System..."
if ! command -v node &> /dev/null; then
  echo "Node.js not found. Please install from https://nodejs.org"
  read -p "Press any key to exit..."
  exit 1
fi
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi
node server.js
read -p "Press any key to exit..."
