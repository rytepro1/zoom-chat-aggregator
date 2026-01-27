# Zoom Chat Aggregator

Aggregates chat messages from multiple Zoom meeting rooms into a single unified feed.

## Quick Start

### Option 1: Double-click (easiest)
Just double-click the `START-SERVER.command` file on your Desktop. It will install everything and start the server automatically.

### Option 2: Terminal
1. Open Terminal
2. Navigate to this folder:
   ```
   cd ~/Desktop/"Chat Aggregator"
   ```
3. Install dependencies:
   ```
   npm install
   cd client && npm install && cd ..
   ```
4. Start the server:
   ```
   npm run dev
   ```

## Viewing the Chat Interface

Once the server is running, open your browser to:
- **http://localhost:5173** - React development server (with hot reload)

Or run the client separately in another terminal:
```
cd client
npm run dev
```

## Configuration

Edit the `.env` file with your Zoom credentials:
- `ZOOM_CLIENT_ID` - From Zoom App settings
- `ZOOM_CLIENT_SECRET` - From Zoom App settings (click "Show" to reveal)
- `ZOOM_WEBHOOK_SECRET_TOKEN` - From Zoom App webhook settings

## Testing Without Zoom

The server includes development endpoints for testing:

```bash
# Add a test message
curl -X POST http://localhost:3001/dev/message \
  -H "Content-Type: application/json" \
  -d '{"sender": "John", "content": "Hello everyone!", "room": "Main Room"}'

# Add a test room
curl -X POST http://localhost:3001/dev/room \
  -H "Content-Type: application/json" \
  -d '{"roomName": "Breakout Room 1", "meetingId": "123"}'

# View current state
curl http://localhost:3001/dev/state
```

## Webhook Setup

Your ngrok URL: `https://unfilamentous-meteorographic-caren.ngrok-free.dev`

Set this as your Zoom webhook endpoint:
`https://unfilamentous-meteorographic-caren.ngrok-free.dev/webhook/zoom`

## Project Structure

```
Chat Aggregator/
├── src/
│   ├── server/          # Express server & Socket.io
│   ├── routes/          # Webhook endpoints
│   ├── middleware/      # Auth validation
│   ├── rtms/            # RTMS connection manager
│   └── services/        # Message aggregation
├── client/              # React frontend
│   └── src/
│       ├── components/  # UI components
│       └── hooks/       # Socket.io hook
├── .env                 # Your credentials (edit this!)
└── START-SERVER.command # Double-click to start
```
