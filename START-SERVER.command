#!/bin/bash

# Zoom Chat Aggregator - Server Startup Script
# Double-click this file to start the server!

cd "$(dirname "$0")"

echo "=================================="
echo "  Zoom Chat Aggregator Setup"
echo "=================================="
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing server dependencies..."
    npm install
    echo ""
fi

# Check if client node_modules exists
if [ ! -d "client/node_modules" ]; then
    echo "📦 Installing client dependencies..."
    cd client && npm install && cd ..
    echo ""
fi

echo "🚀 Starting server on port 3001..."
echo ""
echo "Once started, open http://localhost:5173 in your browser"
echo "to see the chat aggregator interface."
echo ""
echo "Press Ctrl+C to stop the server."
echo "=================================="
echo ""

npm run dev
