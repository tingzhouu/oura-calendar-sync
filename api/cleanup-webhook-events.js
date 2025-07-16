// Vercel Serverless Function: /api/cleanup-webhook-events.js
// Processes unprocessed webhook events and handles retries
// This endpoint should be called periodically via a cron job

import { kv } from '@vercel/kv';

// How old an event needs to be before we consider it for cleanup (5 minutes)
const EVENT_AGE_THRESHOLD = 5 * 60 * 1000;

// Maximum age of events to keep (24 hours)
const MAX_EVENT_AGE = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  // Only allow POST with correct secret
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify secret to prevent unauthorized access
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.WEBHOOK_CLEANUP_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get all webhook event keys
    const keys = await kv.keys('webhook_event:*');
    console.log(`🔍 Found ${keys.length} webhook events`);

    const now = Date.now();
    const results = {
      processed: 0,
      deleted: 0,
      failed: 0,
      skipped: 0
    };

    // Process each event
    for (const key of keys) {
      const event = await kv.get(key);
      if (!event) continue;

      // Extract timestamp from key
      const timestamp = parseInt(key.split(':')[2]);
      const age = now - timestamp;

      // Delete old events
      if (age > MAX_EVENT_AGE) {
        await kv.del(key);
        results.deleted++;
        continue;
      }

      // Skip recently created events
      if (age < EVENT_AGE_THRESHOLD) {
        results.skipped++;
        continue;
      }

      // Skip already processed events
      if (event.processed) {
        results.skipped++;
        continue;
      }

      // Process the event
      try {
        const response = await fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/process-webhook-event`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ eventKey: key })
        });

        if (response.ok) {
          results.processed++;
        } else {
          results.failed++;
        }
      } catch (error) {
        console.error(`❌ Failed to process event ${key}:`, error);
        results.failed++;
      }
    }

    return res.status(200).json({
      success: true,
      results
    });

  } catch (error) {
    console.error('❌ Error in cleanup job:', error);
    return res.status(500).json({ error: 'Cleanup job failed' });
  }
} 