import crypto from 'crypto';

/**
 * Manages RTMS (Real-Time Media Streams) connections to Zoom meetings
 *
 * Note: The actual @zoom/rtms package requires Zoom Developer Pack access.
 * This implementation includes a mock mode for development/testing.
 */
export class RTMSManager {
  constructor(messageAggregator) {
    this.messageAggregator = messageAggregator;
    this.connections = new Map();
    this.useMockMode = true; // Set to false when you have RTMS access
  }

  /**
   * Connect to a meeting's RTMS stream
   */
  async connect(meetingId, streamUrl, roomName, roomColor = '#ef4444') {
    if (this.connections.has(meetingId)) {
      console.log(`Already connected to meeting: ${meetingId}`);
      return;
    }

    if (this.useMockMode) {
      console.log(`[MOCK] Simulating RTMS connection for: ${roomName}`);

      const connection = {
        id: meetingId,
        roomName,
        roomColor,
        mock: true,
        connectedAt: new Date(),
        mockInterval: null
      };

      // Start simulating chat messages for demo purposes
      connection.mockInterval = this.startMockMessages(meetingId, roomName, roomColor);

      this.connections.set(meetingId, connection);
      return;
    }

    // Real RTMS connection code (requires @zoom/rtms package)
    try {
      const client = await this.createRTMSClient(meetingId, streamUrl);

      client.on('chat', (message) => {
        this.handleChatMessage(meetingId, roomName, message);
      });

      client.on('error', (error) => {
        console.error(`RTMS error for ${meetingId}:`, error);
      });

      client.on('disconnect', () => {
        console.log(`RTMS disconnected from ${meetingId}`);
        this.connections.delete(meetingId);
      });

      await client.connect();

      this.connections.set(meetingId, {
        id: meetingId,
        roomName,
        client,
        connectedAt: new Date()
      });

      console.log(`Connected to RTMS stream for: ${roomName}`);
    } catch (error) {
      console.error(`Failed to connect to RTMS: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create RTMS client with authentication
   */
  async createRTMSClient(meetingId, streamUrl) {
    // This requires the @zoom/rtms package
    // const { RTMSClient } = await import('@zoom/rtms');

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.generateSignature(meetingId, timestamp);

    // Placeholder - replace with actual RTMS client creation
    // return new RTMSClient({
    //   streamUrl,
    //   clientId: process.env.ZOOM_CLIENT_ID,
    //   signature,
    //   timestamp
    // });

    throw new Error('RTMS client not implemented - requires @zoom/rtms package');
  }

  /**
   * Generate HMAC signature for RTMS authentication
   */
  generateSignature(meetingId, timestamp) {
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;
    const message = `${meetingId}:${timestamp}`;

    return crypto
      .createHmac('sha256', clientSecret)
      .update(message)
      .digest('hex');
  }

  /**
   * Handle incoming chat message from RTMS stream
   */
  handleChatMessage(meetingId, roomName, message) {
    this.messageAggregator.addMessage({
      sender: message.senderName || 'Unknown',
      content: message.text || message.content,
      room: roomName,
      meetingId,
      timestamp: message.timestamp || new Date().toISOString(),
      type: 'chat'
    });
  }

  /**
   * Start sending mock messages for demo/testing
   */
  startMockMessages(meetingId, roomName, roomColor = '#ef4444') {
    const sampleNames = [
      'Sarah Johnson', 'Mike Chen', 'Emily Davis', 'James Wilson',
      'Maria Garcia', 'David Kim', 'Lisa Thompson', 'Robert Brown',
      'Jennifer Lee', 'Michael Taylor', 'Amanda Martinez', 'Chris Anderson'
    ];

    const sampleMessages = [
      'This is amazing! 🔥',
      'I love this energy!',
      'Incredible insights today',
      'Thank you for sharing this!',
      'Who else is feeling motivated?',
      'Best session ever!',
      'Taking so many notes right now',
      'This changed my perspective',
      'Can\'t wait to implement this',
      'So grateful to be here!',
      'Mind = blown 🤯',
      'YES! This is exactly what I needed',
      'The energy in this room is electric!',
      'Learning so much today',
      'This is life-changing content',
      '🙌🙌🙌',
      'Absolutely incredible!',
      'Who\'s taking action on this?',
      'I\'m ready to transform!',
      'Best investment I\'ve made',
      'The breakthrough moment just happened!',
      'Feeling unstoppable right now'
    ];

    // Send a message every 3-8 seconds
    const interval = setInterval(() => {
      const sender = sampleNames[Math.floor(Math.random() * sampleNames.length)];
      const content = sampleMessages[Math.floor(Math.random() * sampleMessages.length)];

      this.messageAggregator.addMessage({
        sender,
        content,
        room: roomName,
        roomColor,
        meetingId,
        timestamp: new Date().toISOString(),
        type: 'chat'
      });
    }, 3000 + Math.random() * 5000);

    // Send initial welcome message
    setTimeout(() => {
      this.messageAggregator.addMessage({
        sender: 'System',
        content: `Connected to ${roomName} (Mock Mode - Demo messages will appear)`,
        room: roomName,
        roomColor,
        meetingId,
        timestamp: new Date().toISOString(),
        type: 'system'
      });
    }, 500);

    return interval;
  }

  /**
   * Disconnect from a meeting's RTMS stream
   */
  disconnect(meetingId) {
    const connection = this.connections.get(meetingId);

    if (!connection) {
      return;
    }

    // Clear mock message interval if exists
    if (connection.mockInterval) {
      clearInterval(connection.mockInterval);
    }

    if (!connection.mock && connection.client) {
      try {
        connection.client.disconnect();
      } catch (error) {
        console.error(`Error disconnecting from ${meetingId}:`, error);
      }
    }

    this.connections.delete(meetingId);
    console.log(`Disconnected from meeting: ${meetingId}`);
  }

  /**
   * Disconnect from all meetings
   */
  disconnectAll() {
    for (const meetingId of this.connections.keys()) {
      this.disconnect(meetingId);
    }
  }

  /**
   * Get list of active connections
   */
  getActiveConnections() {
    return Array.from(this.connections.values()).map(conn => ({
      meetingId: conn.id,
      roomName: conn.roomName,
      roomColor: conn.roomColor,
      connectedAt: conn.connectedAt,
      isMock: conn.mock || false
    }));
  }
}
