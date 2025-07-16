// Vercel Serverless Function: /api/oura-webhook.js
// Handles Oura webhook verification and event processing

import { kv } from '@vercel/kv';

// TTL for webhook events (5 days in seconds)
const WEBHOOK_EVENT_TTL = 5 * 24 * 60 * 60;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Webhook verification (GET request)
  if (req.method === 'GET') {
    const { verification_token, challenge } = req.query;

    // Verify the token matches our expected token
    if (verification_token === process.env.OURA_WEBHOOK_VERIFICATION_TOKEN) {
      console.log('✅ Webhook verification successful');
      return res.json({ challenge });
    }

    console.error('❌ Invalid verification token');
    return res.status(401).json({ error: 'Invalid verification token' });
  }

  // Webhook event handling (POST request)
  if (req.method === 'POST') {
    try {
      const event = req.body;

      // Validate webhook event
      if (!event || !event.event_type || !event.data_type || !event.user_id  || !event.object_id) {
        console.error('❌ Invalid webhook event:', event);
        return res.status(400).json({ error: 'Invalid webhook event' });
      }

      console.log(`📥 Received ${event.event_type} event for ${event.data_type} ${event.object_id}`);

      // Store the event for processing
      const eventRecord = {
        ...event,
        received_at: new Date().toISOString(),
        processed: false
      };

      // Store in KV with a unique key and 5-day TTL
      const eventKey = `webhook_event:${event.user_id}:${Date.now()}`;
      await kv.set(eventKey, eventRecord, { ex: WEBHOOK_EVENT_TTL });

      // Trigger processing asynchronously
      try {
        console.log(`📥 Triggering async event processing for ${eventKey}`);
        fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/process-webhook-event`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ eventKey })
        })
        .then(() => {
          console.log(`✅ Successfully triggered processing for event: ${eventKey}`);
        })
        .catch(error => {
          console.error('❌ Failed to trigger event processing:', error);
          // We'll retry through the cleanup job
        });
      } catch (error) {
        console.error('❌ Error triggering event processing:', error);
        // We'll retry through the cleanup job
      }

      // Respond quickly (under 10 seconds)
      return res.status(200).json({ success: true });

    } catch (error) {
      console.error('❌ Error processing webhook:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Handle unsupported methods
  return res.status(405).json({ error: 'Method not allowed' });
} 