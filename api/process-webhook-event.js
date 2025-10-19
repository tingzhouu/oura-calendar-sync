// Vercel Serverless Function: /api/process-webhook-event.js
// Processes queued webhook events and updates Google Calendar

import { kv } from "@vercel/kv";

// Maximum number of retries for failed events
const MAX_RETRIES = 3;

// TTL for webhook events (5 days in seconds)
const WEBHOOK_EVENT_TTL = 5 * 24 * 60 * 60;

async function getGoogleUserId(input) {
  const { source, event } = input;
  if (source === "strava") {
    const googleUserId = await kv.get(`strava_user_mapping:${event.owner_id}`);
    if (!googleUserId) {
      console.error(
        "❌ No Google user mapping found for strava user:",
        event.owner_id
      );
    }
    return googleUserId;
  }
  const googleUserId = await kv.get(`oura_user_mapping:${event.user_id}`);
  if (!googleUserId) {
    console.error(
      "❌ No Google user mapping found for Oura user:",
      event.user_id
    );
  }

  return googleUserId;
}

async function getTokens(input) {
  const { source, googleUserId } = input;
  const key =
    source === "strava"
      ? `strava_tokens:${googleUserId}`
      : `oura_tokens:${googleUserId}`;
  const tokens = await kv.get(key);
  return tokens;
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let event;
  const { eventKey, source } = req.body;

  try {
    if (!eventKey) {
      return res.status(400).json({ error: "Missing eventKey parameter" });
    }

    // Get event from KV
    event = await kv.get(eventKey);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    console.log(`🔄 Processing webhook event: ${eventKey}`, event);

    // Get Google user ID from Oura user ID mapping
    const googleUserId = await getGoogleUserId({ event, source });
    if (!googleUserId) {
      console.error(
        "❌ No Google user mapping found for Oura user:",
        event.user_id
      );
      return res.status(400).json({ error: "User mapping not found" });
    }

    // Get user's tokens using Google user ID
    const tokens = await getTokens({ source, googleUserId });
    const googleTokens = await kv.get(`google_tokens:${googleUserId}`);

    if (!tokens || !googleTokens) {
      console.error("❌ Missing user tokens:", {
        ["oura/strava"]: !!tokens,
        source,
        google: !!googleTokens,
      });
      return res.status(400).json({ error: "User tokens not found" });
    }

    if (source === "strava") {
      await processStravaWebhook({
        req,
        event,
        googleTokens,
        tokens,
        googleUserId,
      });

      await kv.set(
        eventKey,
        {
          ...event,
          processed: true,
          processed_at: new Date().toISOString(),
        },
        { ex: WEBHOOK_EVENT_TTL }
      );

      return res.status(200).json({ success: true });
    }

    // Refresh Oura webhook
    await refreshOuraWebhook();

    // Fetch full data from Oura API based on event type
    const ouraData = await fetchOuraData(req, event, googleUserId);
    if (!ouraData) {
      throw new Error("Failed to fetch Oura data");
    }

    // Create calendar event
    await createGoogleCalendarEvent(
      req,
      ouraData,
      event.data_type,
      googleUserId
    );

    // Mark event as processed (maintain 5-day TTL)
    await kv.set(
      eventKey,
      {
        ...event,
        processed: true,
        processed_at: new Date().toISOString(),
      },
      { ex: WEBHOOK_EVENT_TTL }
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Error processing webhook event:", error);

    // Update retry count and potentially requeue (maintain 5-day TTL)
    if (event && (!event.retries || event.retries < MAX_RETRIES)) {
      const retries = (event.retries || 0) + 1;
      await kv.set(
        eventKey,
        {
          ...event,
          retries,
          last_error: error.message,
          last_retry: new Date().toISOString(),
        },
        { ex: WEBHOOK_EVENT_TTL }
      );

      return res.status(500).json({
        error: `Processing failed, check error: ${error.message}`,
        retries,
        eventKey,
      });
    }

    return res.status(500).json({ error: "Processing failed permanently" });
  }
}

async function fetchOuraData(req, event, googleUserId) {
  const baseUrl = "https://api.ouraring.com/v2";
  let endpoint;

  switch (event.data_type) {
    case "sleep":
      endpoint = `/usercollection/sleep/${event.object_id}`;
      break;
    case "workout":
      endpoint = `/usercollection/workout/${event.object_id}`;
      break;
    case "session":
      endpoint = `/usercollection/session/${event.object_id}`;
      break;
    default:
      throw new Error(`Unsupported data type: ${event.data_type}`);
  }

  // Get current Oura tokens
  let ouraTokens = await kv.get(`oura_tokens:${googleUserId}`);
  let response = await fetch(`${baseUrl}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${ouraTokens.access_token}`,
    },
  });

  // If token expired, try to refresh and retry
  if (response.status === 401) {
    console.log("🔄 Oura access token expired, attempting refresh...");

    const refreshResponse = await fetch(
      `${req.headers["x-forwarded-proto"] || "https"}://${
        req.headers.host
      }/api/refresh-oura-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: googleUserId }),
      }
    );

    if (refreshResponse.ok) {
      const refreshResult = await refreshResponse.json();
      console.log("✅ Oura token refreshed successfully, retrying data fetch");

      // Retry with new token
      response = await fetch(`${baseUrl}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${refreshResult.access_token}`,
        },
      });
    } else {
      const refreshError = await refreshResponse.json();
      if (refreshError.reauth_required) {
        throw new Error("User needs to re-authenticate with Oura");
      }
      throw new Error("Failed to refresh Oura access token");
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch Oura data: ${response.status} - ${errorText}`
    );
  }

  return response.json();
}

async function refreshOuraWebhook() {
  const baseUrl = "https://api.ouraring.com/v2/webhook/subscription";
  const getWebhooksResponse = await fetch(baseUrl, {
    headers: {
      "x-client-id": process.env.OURA_CLIENT_ID,
      "x-client-secret": process.env.OURA_CLIENT_SECRET,
    },
  });

  if (getWebhooksResponse.status !== 200) {
    const text = await getWebhooksResponse.text();
    const errorMessage = `Unable to fetch webhooks from Oura ${getWebhooksResponse.status} ${text}`;
    console.error(errorMessage);
    throw new Error(errorMessage);
  }

  const webhooks = await getWebhooksResponse.json();
  if (!Array.isArray(webhooks)) {
    const errorMessage = `Received ${JSON.stringify(
      webhooks
    )} that is not an Array`;
    console.error(errorMessage);
    throw new Error(errorMessage);
  }

  for (const webhook of webhooks) {
    if (!webhook.id) {
      const errorMessage = `Received ${JSON.stringify(
        webhook
      )} that does not have an id`;
      console.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  for (const webhook of webhooks) {
    const res = await fetch(`${baseUrl}/renew/${webhook.id}`, {
      method: "PUT",
      headers: {
        "x-client-id": process.env.OURA_CLIENT_ID,
        "x-client-secret": process.env.OURA_CLIENT_SECRET,
      },
    });
    if (res.status !== 200) {
      const text = await res.text();
      const errorMessage = `Failed to refresh oura webhook for ${webhook.data_type} id ${webhook.id}  ${res.status} ${text}`;
      console.error(errorMessage);
      throw new Error(errorMessage);
    }
    console.log(
      `Refreshed oura webhook for ${webhook.data_type} id ${webhook.id}`
    );
  }
}

async function createGoogleCalendarEvent(req, ouraData, dataType, userId) {
  // Format event data based on type
  const event = formatCalendarEvent(ouraData, dataType);

  // Get user's calendar preference or use primary
  const calendarPrefs = await kv.get(`calendar_prefs:${userId}`);
  const calendarId = calendarPrefs?.[dataType] || "primary";

  // Try to create the event with current access token
  let googleTokens = await kv.get(`google_tokens:${userId}`);
  let response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${googleTokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );

  // If token expired, try to refresh and retry
  if (response.status === 401) {
    console.log("🔄 Access token expired, attempting refresh...");

    const refreshResponse = await fetch(
      `${req.headers["x-forwarded-proto"] || "https"}://${
        req.headers.host
      }/api/refresh-google-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId }),
      }
    );

    if (refreshResponse.ok) {
      const refreshResult = await refreshResponse.json();
      console.log(
        "✅ Token refreshed successfully, retrying calendar event creation"
      );

      // Retry with new token
      response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
          calendarId
        )}/events`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${refreshResult.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(event),
        }
      );
    } else {
      const refreshError = await refreshResponse.json();
      if (refreshError.reauth_required) {
        throw new Error("User needs to re-authenticate with Google");
      }
      throw new Error("Failed to refresh access token");
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create calendar event: ${response.status} - ${errorText}`
    );
  }

  return response.json();
}

function formatCalendarEvent(ouraData, dataType) {
  switch (dataType) {
    case "sleep":
      const sleepDuration = calculateDuration(
        ouraData.bedtime_start,
        ouraData.bedtime_end
      );
      return {
        summary: `💤 Sleep: ${formatDuration(sleepDuration)}`,
        description: formatSleepDescription(ouraData),
        start: { dateTime: ouraData.bedtime_start },
        end: { dateTime: ouraData.bedtime_end },
      };

    case "workout":
      const workoutDuration = calculateDuration(
        ouraData.start_datetime,
        ouraData.end_datetime
      );
      return {
        summary: `🏃‍♂️ ${ouraData.activity}: ${formatDuration(workoutDuration)}`,
        description: formatWorkoutDescription(ouraData),
        start: { dateTime: ouraData.start_datetime },
        end: { dateTime: ouraData.end_datetime },
      };

    case "session":
      const sessionDuration = calculateDuration(
        ouraData.start_datetime,
        ouraData.end_datetime
      );
      const sessionHrStats = calculateArrayStats(ouraData.heart_rate?.items);
      const avgHrText = sessionHrStats.avg
        ? ` (${sessionHrStats.avg} bpm avg)`
        : "";

      return {
        summary: `🧘‍♂️ ${ouraData.type}: ${formatDuration(
          sessionDuration
        )}${avgHrText}`,
        description: formatSessionDescription(ouraData),
        start: { dateTime: ouraData.start_datetime },
        end: { dateTime: ouraData.end_datetime },
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
  const validValues = items.filter(
    (value) => value !== null && value !== undefined && !isNaN(value)
  );

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
    count: validValues.length,
  };
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) {
    return "0m";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatSleepDescription(data) {
  const totalDuration = calculateDuration(data.bedtime_start, data.bedtime_end);

  return `Sleep Score: ${data.score || "N/A"}
Total Sleep Time: ${formatDuration(totalDuration)}
Sleep Stages:
- Deep: ${formatDuration(data.deep_sleep_duration || 0)}
- REM: ${formatDuration(data.rem_sleep_duration || 0)}
- Light: ${formatDuration(data.light_sleep_duration || 0)}
- Awake: ${formatDuration(data.awake_duration || 0)}

Heart Rate: ${data.average_heart_rate || "N/A"} bpm
HRV: ${data.average_hrv || "N/A"} ms
Respiratory Rate: ${data.average_breath || "N/A"} br/min`;
}

function formatWorkoutDescription(data) {
  const duration = calculateDuration(data.start_datetime, data.end_datetime);

  return `Activity: ${data.activity}
Duration: ${formatDuration(duration)}
Distance: ${data.distance ? `${(data.distance / 1000).toFixed(2)} km` : "N/A"}
Calories: ${data.calories || "N/A"} kcal
Heart Rate:
- Average: ${data.average_heart_rate || "N/A"} bpm
- Max: ${data.max_heart_rate || "N/A"} bpm`;
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
- Average: ${hrStats.avg !== null ? `${hrStats.avg} bpm` : "N/A"}
- Min: ${hrStats.min !== null ? `${hrStats.min} bpm` : "N/A"}
- Max: ${hrStats.max !== null ? `${hrStats.max} bpm` : "N/A"}
HRV:
- Average: ${hrvStats.avg !== null ? `${hrvStats.avg} ms` : "N/A"}
- Min: ${hrvStats.min !== null ? `${hrvStats.min} ms` : "N/A"}
- Max: ${hrvStats.max !== null ? `${hrvStats.max} ms` : "N/A"}
Data Points: ${hrStats.count} HR readings, ${hrvStats.count} HRV readings`;
}

async function processStravaWebhook(input) {
  const { req, event, googleTokens, tokens, googleUserId } = input;

  if (event.object_type !== "activity") {
    return;
  }

  // Fetch full data from Oura API based on event type
  const stravaData = await fetchStravaData({
    event,
    googleUserId,
    stravaTokens: tokens,
  });
  if (!stravaData) {
    throw new Error("Failed to fetch Strava data");
  }
  if (!["Run", "Workout", "WeightTraining"].includes(stravaData.type)) {
    return;
  }

  await createStravaGoogleCalendarEvent({
    req,
    stravaData,
    userId: googleUserId,
    googleTokens,
  });
}

async function refreshStravaTokens(input) {
  const { stravaTokens, googleUserId: userId } = input;
  // Check if Strava client secret is configured
  const STRAVA_CLIENT_ID = 177491;
  const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

  if (!STRAVA_CLIENT_SECRET) {
    return res.status(500).json({
      error: "Server configuration error: STRAVA_CLIENT_SECRET not set",
    });
  }

  // Refresh the access token
  const refreshData = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stravaTokens.refresh_token,
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
  });

  console.log("🔄 Refreshing Strava access token...");

  const refreshResponse = await fetch(
    "https://www.strava.com/api/v3/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: refreshData,
    }
  );

  if (!refreshResponse.ok) {
    const errorText = await refreshResponse.text();
    console.error(
      `❌ Strava token refresh failed: ${refreshResponse.status} - ${errorText}`
    );

    // If refresh token is invalid, user needs to re-authenticate
    if (refreshResponse.status === 400) {
      throw new Error(
        `Refresh token expired or invalid, re-authenticate with strava`
      );
    }

    throw new Error(
      `Token refresh failed, Strava API returned ${refreshResponse.status}`
    );
  }

  const newTokens = await refreshResponse.json();

  // Validate token response
  if (!newTokens.access_token) {
    console.error(`❌ Invalid refresh response from Strava:`, newTokens);
    throw new Error(`Invalid refresh response from Strava`);
  }

  // Update stored tokens (keep existing refresh token if not provided)
  const updatedTokenRecord = {
    ...stravaTokens,
    access_token: newTokens.access_token,
    token_type: newTokens.token_type || "Bearer",
    expires_in: newTokens.expires_in || 3600,
    scope: newTokens.scope || stravaTokens.scope,
    last_used: new Date().toISOString(),
    refreshed_at: new Date().toISOString(),
  };

  // If a new refresh token is provided, update it
  if (newTokens.refresh_token) {
    updatedTokenRecord.refresh_token = newTokens.refresh_token;
  }

  await kv.set(`strava_tokens:${userId}`, updatedTokenRecord);

  console.log(`✅ Strava access token refreshed for user: ${userId}`);
  return {
    success: true,
    access_token: updatedTokenRecord.access_token,
  };
}

async function fetchStravaData(input) {
  const { event, googleUserId, stravaTokens } = input;
  if (event.object_type !== "activity") {
    return;
  }
  const url = `https://www.strava.com/api/v3/activities/${event.object_id}`;

  // Get current Oura tokens
  let response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${stravaTokens.access_token}`,
    },
  });

  // If token expired, try to refresh and retry
  if (response.status === 401) {
    console.log("🔄 Strava access token expired, attempting refresh...");

    const refreshResponse = await refreshStravaTokens({
      googleUserId,
      stravaTokens,
    });

    if (refreshResponse.success) {
      console.log(
        "✅ Strava token refreshed successfully, retrying data fetch"
      );

      // Retry with new token
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${refreshResponse.access_token}`,
        },
      });
    } else {
      throw new Error("Failed to refresh Strava access token");
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch Strava data: ${response.status} - ${errorText}`
    );
  }

  return response.json();
}

async function createStravaGoogleCalendarEvent(input) {
  const { req, stravaData, userId, googleTokens } = input;
  // Format event data based on type
  const event = formatStravaCalendarEvent({ stravaData });
  // Get user's calendar preference or use primary
  const calendarPrefs = await kv.get(`calendar_prefs:${userId}`);
  const calendarId =
    calendarPrefs?.[`strava.${stravaData.type.toLowerCase()}`] || "primary";

  // Try to create the event with current access token
  let response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${googleTokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );

  // If token expired, try to refresh and retry
  if (response.status === 401) {
    console.log("🔄 Access token expired, attempting refresh...");

    const refreshResponse = await fetch(
      `${req.headers["x-forwarded-proto"] || "https"}://${
        req.headers.host
      }/api/refresh-google-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId }),
      }
    );

    if (refreshResponse.ok) {
      const refreshResult = await refreshResponse.json();
      console.log(
        "✅ Token refreshed successfully, retrying calendar event creation"
      );

      // Retry with new token
      response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
          calendarId
        )}/events`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${refreshResult.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(event),
        }
      );
    } else {
      const refreshError = await refreshResponse.json();
      if (refreshError.reauth_required) {
        throw new Error("User needs to re-authenticate with Google");
      }
      throw new Error("Failed to refresh access token");
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create calendar event: ${response.status} - ${errorText}`
    );
  }

  return response.json();
}

function formatRunDescription(stravaData) {
  // Strava gives distance in meters
  const distanceKm = (stravaData.distance / 1000).toFixed(2);

  // Strava gives average_speed in m/s
  const avgSpeedKph = (stravaData.average_speed * 3.6).toFixed(2);

  // Calculate pace (min/km)
  let pacePerKm = null;
  if (stravaData.average_speed > 0) {
    const paceSeconds = 1000 / stravaData.average_speed; // seconds per km
    const paceMinutes = Math.floor(paceSeconds / 60);
    const paceRemainingSec = Math.round(paceSeconds % 60)
      .toString()
      .padStart(2, "0");
    pacePerKm = `${paceMinutes}:${paceRemainingSec}`;
  }

  const elevation = stravaData.total_elevation_gain || 0;
  const avgHr = stravaData.average_heartrate || "—";
  const maxHr = stravaData.max_heartrate || "—";
  const calories = stravaData.calories || "—";
  const activityUrl = `https://www.strava.com/activities/${stravaData.id}`;

  return `Distance: ${distanceKm} km
Pace: ${pacePerKm} min/km
Speed: ${avgSpeedKph} km/h
Elevation: ${elevation} m

Average HR: ${avgHr}
Max HR: ${maxHr}
Calories: ${calories}

${activityUrl}`;
}

function formatStravaCalendarEvent(input) {
  const { stravaData } = input;

  const distanceKm = (stravaData.distance / 1000).toFixed(2);

  // Convert start_date to Date
  const startDate = new Date(stravaData.start_date);

  // Compute end time by adding elapsed_time (in seconds)
  const endDate = new Date(
    startDate.getTime() + stravaData.elapsed_time * 1000
  );

  if (stravaData.type === "Run") {
    return {
      summary: `🏃‍♂️ Run: - ${distanceKm}km`,
      description: formatRunDescription(stravaData),
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() },
    };
  }

  if (stravaData.type === "Workout") {
    return {
      summary: "Stretch",
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() },
    };
  }

  if (stravaData.type === "WeightTraining") {
    return {
      summary: "Static Exercises",
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() },
    };
  }
}
