// Vercel Serverless Function: /api/oura-webhook.js
// Handles Oura webhook verification and event processing

import { kv } from '@vercel/kv';

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
      if (!event || !event.event_type || !event.data_type || !event.user_id) {
        console.error('❌ Invalid webhook event:', event);
        return res.status(400).json({ error: 'Invalid webhook event' });
      }

      console.log(`📥 Received ${event.event_type} event for ${event.data_type}`);

      // Store the event for processing
      const eventRecord = {
        ...event,
        received_at: new Date().toISOString(),
        processed: false
      };

      // Store in KV with a unique key
      const eventKey = `webhook_event:${event.user_id}:${Date.now()}`;
      await kv.set(eventKey, eventRecord);

      // Queue event for processing (we'll implement this later)
      // For now, just log it
      console.log('Event queued for processing:', eventRecord);

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