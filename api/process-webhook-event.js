// Vercel Serverless Function: /api/process-webhook-event.js
// Processes queued webhook events and updates Google Calendar

import { kv } from '@vercel/kv';

// Maximum number of retries for failed events
const MAX_RETRIES = 3;

// TTL for webhook events (5 days in seconds)
const WEBHOOK_EVENT_TTL = 5 * 24 * 60 * 60;

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let event

  try {
    const { eventKey } = req.body;
    if (!eventKey) {
      return res.status(400).json({ error: 'Missing eventKey parameter' });
    }

    // Get event from KV
    event = await kv.get(eventKey);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    console.log(`🔄 Processing webhook event: ${eventKey}`, event);

    // Get Google user ID from Oura user ID mapping
    const googleUserId = await kv.get(`oura_user_mapping:${event.user_id}`);
    if (!googleUserId) {
      console.error('❌ No Google user mapping found for Oura user:', event.user_id);
      return res.status(400).json({ error: 'User mapping not found' });
    }

    // Get user's tokens using Google user ID
    const tokens = await kv.get(`oura_tokens:${googleUserId}`);
    const googleTokens = await kv.get(`google_tokens:${googleUserId}`);

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
    await createGoogleCalendarEvent(ouraData, event.data_type, googleUserId);

    // Mark event as processed (maintain 5-day TTL)
    await kv.set(eventKey, {
      ...event,
      processed: true,
      processed_at: new Date().toISOString()
    }, { ex: WEBHOOK_EVENT_TTL });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Error processing webhook event:', error);

    // Update retry count and potentially requeue (maintain 5-day TTL)
    if (event && (!event.retries || event.retries < MAX_RETRIES)) {
      const retries = (event.retries || 0) + 1;
      await kv.set(eventKey, {
        ...event,
        retries,
        last_error: error.message,
        last_retry: new Date().toISOString()
      }, { ex: WEBHOOK_EVENT_TTL });

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

async function createGoogleCalendarEvent(ouraData, dataType, userId) {
  // Format event data based on type
  const event = formatCalendarEvent(ouraData, dataType);

  // Get user's calendar preference or use primary
  const calendarPrefs = await kv.get(`calendar_prefs:${userId}`);
  const calendarId = calendarPrefs?.[dataType] || 'primary';

  // Try to create the event with current access token
  let googleTokens = await kv.get(`google_tokens:${userId}`);
  let response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${googleTokens.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  // If token expired, try to refresh and retry
  if (response.status === 401) {
    console.log('🔄 Access token expired, attempting refresh...');
    
    const refreshResponse = await fetch(`${process.env.VERCEL_URL || 'https://oura-calendar-sync.vercel.app'}/api/refresh-google-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userId })
    });

    if (refreshResponse.ok) {
      const refreshResult = await refreshResponse.json();
      console.log('✅ Token refreshed successfully, retrying calendar event creation');
      
      // Retry with new token
      response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${refreshResult.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(event)
      });
    } else {
      const refreshError = await refreshResponse.json();
      if (refreshError.reauth_required) {
        throw new Error('User needs to re-authenticate with Google');
      }
      throw new Error('Failed to refresh access token');
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create calendar event: ${response.status} - ${errorText}`);
  }

  return response.json();
}

function formatCalendarEvent(ouraData, dataType) {
  switch (dataType) {
    case 'sleep':
      const sleepDuration = calculateDuration(ouraData.bedtime_start, ouraData.bedtime_end);
      return {
        summary: `💤 Sleep: ${formatDuration(sleepDuration)}`,
        description: formatSleepDescription(ouraData),
        start: { dateTime: ouraData.bedtime_start },
        end: { dateTime: ouraData.bedtime_end },
        colorId: '9', // Blue
        transparency: 'transparent' // Don't show as busy
      };

    case 'workout':
      const workoutDuration = calculateDuration(ouraData.start_datetime, ouraData.end_datetime);
      return {
        summary: `🏃‍♂️ ${ouraData.activity}: ${formatDuration(workoutDuration)}`,
        description: formatWorkoutDescription(ouraData),
        start: { dateTime: ouraData.start_datetime },
        end: { dateTime: ouraData.end_datetime },
        colorId: '10', // Green
      };

    case 'session':
      const sessionDuration = calculateDuration(ouraData.start_datetime, ouraData.end_datetime);
      const sessionHrStats = calculateArrayStats(ouraData.heart_rate?.items);
      const avgHrText = sessionHrStats.avg ? ` (${sessionHrStats.avg} bpm avg)` : '';
      
      return {
        summary: `🧘‍♂️ ${ouraData.type}: ${formatDuration(sessionDuration)}${avgHrText}`,
        description: formatSessionDescription(ouraData),
        start: { dateTime: ouraData.start_datetime },
        end: { dateTime: ouraData.end_datetime },
        colorId: '6', // Purple
      };

    default:
      throw new Error(`Unsupported data type: ${dataType}`);
  }
}

function calculateDuration(startDateTime, endDateTime) {
  if (!startDateTime || !endDateTime) {
    return 0;
  }
  
  const start = new Date(startDateTime);
  const end = new Date(endDateTime);
  
  // Return duration in seconds
  return Math.floor((end - start) / 1000);
}

function calculateArrayStats(items) {
  if (!items || !Array.isArray(items)) {
    return { avg: null, min: null, max: null, count: 0 };
  }
  
  // Filter out null values
  const validValues = items.filter(value => value !== null && value !== undefined && !isNaN(value));
  
  if (validValues.length === 0) {
    return { avg: null, min: null, max: null, count: 0 };
  }
  
  const sum = validValues.reduce((acc, val) => acc + val, 0);
  const avg = sum / validValues.length;
  const min = Math.min(...validValues);
  const max = Math.max(...validValues);
  
  return {
    avg: Math.round(avg * 10) / 10, // Round to 1 decimal place
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    count: validValues.length
  };
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) {
    return '0m';
  }
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatSleepDescription(data) {
  const totalDuration = calculateDuration(data.bedtime_start, data.bedtime_end);
  
  return `Sleep Score: ${data.score || 'N/A'}
Total Sleep Time: ${formatDuration(totalDuration)}
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
  const duration = calculateDuration(data.start_datetime, data.end_datetime);
  
  return `Activity: ${data.activity}
Duration: ${formatDuration(duration)}
Distance: ${data.distance ? `${(data.distance / 1000).toFixed(2)} km` : 'N/A'}
Calories: ${data.calories || 'N/A'} kcal
Heart Rate:
- Average: ${data.average_heart_rate || 'N/A'} bpm
- Max: ${data.max_heart_rate || 'N/A'} bpm`;
}

function formatSessionDescription(data) {
  const duration = calculateDuration(data.start_datetime, data.end_datetime);
  
  // Calculate heart rate statistics from raw data
  const hrStats = calculateArrayStats(data.heart_rate?.items);
  
  // Calculate HRV statistics from raw data
  const hrvStats = calculateArrayStats(data.heart_rate_variability?.items);
  
  return `Type: ${data.type}
Duration: ${formatDuration(duration)}
Heart Rate:
- Average: ${hrStats.avg !== null ? `${hrStats.avg} bpm` : 'N/A'}
- Min: ${hrStats.min !== null ? `${hrStats.min} bpm` : 'N/A'}
- Max: ${hrStats.max !== null ? `${hrStats.max} bpm` : 'N/A'}
HRV:
- Average: ${hrvStats.avg !== null ? `${hrvStats.avg} ms` : 'N/A'}
- Min: ${hrvStats.min !== null ? `${hrvStats.min} ms` : 'N/A'}
- Max: ${hrvStats.max !== null ? `${hrvStats.max} ms` : 'N/A'}
Data Points: ${hrStats.count} HR readings, ${hrvStats.count} HRV readings`;
} 