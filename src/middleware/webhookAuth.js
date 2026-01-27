import crypto from 'crypto';

/**
 * Middleware to validate Zoom webhook signatures
 */
export function validateZoomWebhook(req, res, next) {
  // Skip validation for URL validation challenges
  if (req.body.event === 'endpoint.url_validation') {
    return next();
  }

  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];
  const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

  if (!signature || !timestamp) {
    console.error('Missing signature headers');
    return res.status(401).json({ error: 'Missing authentication headers' });
  }

  if (!webhookSecret) {
    console.error('ZOOM_WEBHOOK_SECRET_TOKEN not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Validate timestamp (within 5 minutes)
  const currentTime = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);

  if (Math.abs(currentTime - requestTime) > 300) {
    console.error('Webhook timestamp expired');
    return res.status(401).json({ error: 'Request expired' });
  }

  // Calculate expected signature
  const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const expectedSignature = 'v0=' + crypto
    .createHmac('sha256', webhookSecret)
    .update(message)
    .digest('hex');

  // Constant-time comparison
  try {
    const isValid = crypto.timingSafeEquals(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!isValid) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (error) {
    console.error('Signature validation error:', error);
    return res.status(401).json({ error: 'Signature validation failed' });
  }

  next();
}

/**
 * Generate HMAC signature for RTMS authentication
 */
export function generateRTMSSignature(meetingId, timestamp) {
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!clientSecret) {
    throw new Error('ZOOM_CLIENT_SECRET not configured');
  }

  const message = `${meetingId}:${timestamp}`;

  return crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');
}
