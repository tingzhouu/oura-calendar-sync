// Vercel Serverless Function: /api/oura-webhook.js
// Handles Oura webhook verification and event processing

import { kv } from '@vercel/kv';

// TTL for webhook events (5 days in seconds)
const WEBHOOK_EVENT_TTL = 5 * 24 * 60 * 60;
const DEBUG_EVENT_TTL = 14 * 24 * 60 * 60;
const MAX_DEBUG_ENTRIES = 200;

async function appendDebugEvent(input) {
  const { objectId, eventKey = null, stage, data = {} } = input;
  if (!objectId || !stage) {
    return;
  }

  const debugKey = `debug:oura:${objectId}`;
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    stage,
    eventKey,
    ...data
  };

  try {
    const existing = await kv.get(debugKey);
    const entries = Array.isArray(existing?.entries) ? existing.entries : [];
    entries.push(entry);

    await kv.set(debugKey, {
      source: 'oura',
      object_id: objectId,
      updated_at: timestamp,
      entries: entries.slice(-MAX_DEBUG_ENTRIES)
    }, { ex: DEBUG_EVENT_TTL });
  } catch (debugError) {
    console.error('❌ Failed to persist webhook debug event:', debugError);
  }
}

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

      const duplicateCounterKey = `debug:dupe:oura:${event.user_id}:${event.data_type}:${event.event_type}:${event.object_id}`;
      const duplicateCount = Number(await kv.get(duplicateCounterKey) || 0) + 1;
      await kv.set(duplicateCounterKey, duplicateCount, { ex: DEBUG_EVENT_TTL });

      await appendDebugEvent({
        objectId: event.object_id,
        stage: 'webhook_received',
        data: {
          event_type: event.event_type,
          data_type: event.data_type,
          user_id: event.user_id,
          event_time: event.event_time || null,
          duplicate_count: duplicateCount
        }
      });

      // Store the event for processing
      const eventRecord = {
        ...event,
        received_at: new Date().toISOString(),
        processed: false
      };

      // Store in KV with a unique key and 5-day TTL
      const eventKey = `webhook_event:${event.user_id}:${Date.now()}`;
      await kv.set(eventKey, eventRecord, { ex: WEBHOOK_EVENT_TTL });
      await appendDebugEvent({
        objectId: event.object_id,
        eventKey,
        stage: 'webhook_stored',
        data: {
          received_at: eventRecord.received_at
        }
      });

      // Trigger processing asynchronously
      try {
        console.log(`📥 Triggering async event processing for ${eventKey}`);
        
        // Use a timeout to ensure we respond quickly while still ensuring the fetch is sent
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Processing trigger timeout')), 2500)
        );
        
        const processingPromise = fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/process-webhook-event`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ eventKey })
        }).then(response => {
          console.log(`✅ Successfully triggered processing for event: ${eventKey}, status: ${response.status}`);
          appendDebugEvent({
            objectId: event.object_id,
            eventKey,
            stage: 'processing_triggered',
            data: {
              trigger_status: response.status
            }
          });
          return response;
        });

        // Wait to ensure request is sent, but don't wait for completion
        await Promise.race([processingPromise, timeoutPromise]).catch(error => {
          if (error.message.includes('timeout')) {
            console.log('⏱️ Processing trigger timed out (request likely sent)');
            appendDebugEvent({
              objectId: event.object_id,
              eventKey,
              stage: 'processing_trigger_timeout'
            });
          } else {
            console.error('❌ Failed to trigger event processing:', error);
            appendDebugEvent({
              objectId: event.object_id,
              eventKey,
              stage: 'processing_trigger_failed',
              data: {
                error: error.message
              }
            });
          }
        });

      } catch (error) {
        console.error('❌ Error triggering event processing:', error);
        await appendDebugEvent({
          objectId: event.object_id,
          eventKey,
          stage: 'processing_trigger_exception',
          data: {
            error: error.message
          }
        });
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
