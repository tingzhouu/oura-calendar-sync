// Vercel Serverless Function: /api/process-webhook-event.js
// Processes queued webhook events and updates Google Calendar

import { kv } from '@vercel/kv';

// Maximum number of retries for failed events
const MAX_RETRIES = 3;

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { eventKey } = req.body;
    if (!eventKey) {
      return res.status(400).json({ error: 'Missing eventKey parameter' });
    }

    // Get event from KV
    const event = await kv.get(eventKey);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    console.log(`🔄 Processing webhook event: ${eventKey}`, event);

    // Get user's tokens
    const tokens = await kv.get(`oura_tokens:${event.user_id}`);
    const googleTokens = await kv.get(`google_tokens:${event.user_id}`);

    if (!tokens || !googleTokens) {
      console.error('❌ Missing user tokens:', { oura: !!tokens, google: !!googleTokens });
      return res.status(400).json({ error: 'User tokens not found' });
    }

    // Fetch full data from Oura API based on event type
    const ouraData = await fetchOuraData(event, tokens.access_token);
    if (!ouraData) {
      throw new Error('Failed to fetch Oura data');
    }

    // Create calendar event
    await createGoogleCalendarEvent(ouraData, event.data_type, googleTokens.access_token);

    // Mark event as processed
    await kv.set(eventKey, {
      ...event,
      processed: true,
      processed_at: new Date().toISOString()
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Error processing webhook event:', error);

    // Update retry count and potentially requeue
    if (event && (!event.retries || event.retries < MAX_RETRIES)) {
      const retries = (event.retries || 0) + 1;
      await kv.set(eventKey, {
        ...event,
        retries,
        last_error: error.message,
        last_retry: new Date().toISOString()
      });

      return res.status(500).json({
        error: 'Processing failed, will retry',
        retries,
        eventKey
      });
    }

    return res.status(500).json({ error: 'Processing failed permanently' });
  }
}

async function fetchOuraData(event, accessToken) {
  const baseUrl = 'https://api.ouraring.com/v2';
  let endpoint;

  switch (event.data_type) {
    case 'sleep':
      endpoint = `/usercollection/sleep/${event.object_id}`;
      break;
    case 'workout':
      endpoint = `/usercollection/workout/${event.object_id}`;
      break;
    case 'session':
      endpoint = `/usercollection/session/${event.object_id}`;
      break;
    default:
      throw new Error(`Unsupported data type: ${event.data_type}`);
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Oura data: ${response.status}`);
  }

  return response.json();
}

async function createGoogleCalendarEvent(ouraData, dataType, accessToken) {
  // Format event data based on type
  const event = formatCalendarEvent(ouraData, dataType);

  // Get user's calendar preference or use primary
  const calendarPrefs = await kv.get(`calendar_prefs:${event.user_id}`);
  const calendarId = calendarPrefs?.[dataType] || 'primary';

  // Create event in Google Calendar
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    throw new Error(`Failed to create calendar event: ${response.status}`);
  }

  return response.json();
}

function formatCalendarEvent(ouraData, dataType) {
  switch (dataType) {
    case 'sleep':
      return {
        summary: `💤 Sleep: ${formatDuration(ouraData.duration)}`,
        description: formatSleepDescription(ouraData),
        start: { dateTime: ouraData.bedtime_start },
        end: { dateTime: ouraData.bedtime_end },
        colorId: '9', // Blue
        transparency: 'transparent' // Don't show as busy
      };

    case 'workout':
      return {
        summary: `🏃‍♂️ ${ouraData.activity}: ${formatDuration(ouraData.duration)}`,
        description: formatWorkoutDescription(ouraData),
        start: { dateTime: ouraData.start_datetime },
        end: { dateTime: ouraData.end_datetime },
        colorId: '10', // Green
      };

    case 'session':
      return {
        summary: `🧘‍♂️ ${ouraData.type}: ${formatDuration(ouraData.duration)}`,
        description: formatSessionDescription(ouraData),
        start: { dateTime: ouraData.start_datetime },
        end: { dateTime: ouraData.end_datetime },
        colorId: '6', // Purple
      };

    default:
      throw new Error(`Unsupported data type: ${dataType}`);
  }
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatSleepDescription(data) {
  return `Sleep Score: ${data.score || 'N/A'}
Sleep Stages:
- Deep: ${formatDuration(data.deep_sleep_duration || 0)}
- REM: ${formatDuration(data.rem_sleep_duration || 0)}
- Light: ${formatDuration(data.light_sleep_duration || 0)}
- Awake: ${formatDuration(data.awake_duration || 0)}

Heart Rate: ${data.average_heart_rate || 'N/A'} bpm
HRV: ${data.average_hrv || 'N/A'} ms
Respiratory Rate: ${data.average_breath || 'N/A'} br/min`;
}

function formatWorkoutDescription(data) {
  return `Activity: ${data.activity}
Duration: ${formatDuration(data.duration)}
Distance: ${data.distance ? `${(data.distance / 1000).toFixed(2)} km` : 'N/A'}
Calories: ${data.calories || 'N/A'} kcal
Heart Rate:
- Average: ${data.average_heart_rate || 'N/A'} bpm
- Max: ${data.max_heart_rate || 'N/A'} bpm`;
}

function formatSessionDescription(data) {
  return `Type: ${data.type}
Duration: ${formatDuration(data.duration)}
Heart Rate:
- Average: ${data.average_heart_rate || 'N/A'} bpm
- Max: ${data.max_heart_rate || 'N/A'} bpm
HRV: ${data.average_hrv || 'N/A'} ms`;
} 