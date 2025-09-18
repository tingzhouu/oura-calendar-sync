// Vercel Serverless Function: /api/strava-callback.js
// Handles Strava OAuth callback directly - receives code, exchanges for tokens, redirects to frontend

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  console.log("🔄 Strava OAuth callback received");

  try {
    // Get OAuth parameters from query string
    const { code, scope, error, state } = req.query;

    // Handle OAuth errors
    if (error) {
      console.error("❌ Strava OAuth error:", error);
      return res.redirect(
        `${
          process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
        }?oura_error=${encodeURIComponent(error)}`
      );
    }

    // Validate required parameters
    if (!code || !scope || !state) {
      console.error("❌ Missing code or scope in Strava callback");
      return res.redirect(
        `${
          process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
        }?oura_error=missing_parameters`
      );
    }

    // Get user ID from state (we'll need to store this when initiating OAuth)
    // For now, we'll extract it from the state parameter
    let userId;
    try {
      // State format: "userId:randomString"
      userId = state.split(":")[0];
      if (!userId) {
        throw new Error("Invalid state format");
      }
    } catch (err) {
      console.error("❌ Invalid state parameter:", state);
      return res.redirect(
        `${
          process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
        }?oura_error=invalid_state`
      );
    }

    // Check if Strava client secret is configured
    const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
    if (!STRAVA_CLIENT_SECRET) {
      console.error("❌ STRAVA_CLIENT_SECRET not configured");
      return res.redirect(
        `${
          process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
        }?oura_error=server_config`
      );
    }

    // Exchange authorization code for access token
    const tokenData = new URLSearchParams({
      client_id: 177491, // strava client id
      client_secret: STRAVA_CLIENT_SECRET,
      code: code,
      grant_type: "authorization_code",
    });

    console.log(`🔄 Exchanging Strava code for tokens for user: ${userId}`);

    // Make request to Strava token endpoint
    const tokenResponse = await fetch(
      "https://www.strava.com/api/v3/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: tokenData,
      }
    );

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(
        `❌ Strava token exchange failed: ${tokenResponse.status} - ${errorText}`
      );
      return res.redirect(
        `${
          process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
        }?strava_error=token_exchange_failed`
      );
    }

    const tokens = await tokenResponse.json();

    // Validate token response
    if (!tokens.access_token || !tokens.refresh_token || !tokens.athlete) {
      console.error(`❌ Invalid token response from Strava:`, tokens);
      return res.redirect(
        `${
          process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
        }?oura_error=invalid_tokens`
      );
    }

    console.log(
      `🔄 Strava token - athlete response:`,
      JSON.stringify(tokens.athlete)
    );

    const stravaUserId = tokens.athlete.id;

    if (!stravaUserId) {
      console.error("❌ No Strava user ID in token response");
      return res.redirect(
        `${
          process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
        }?oura_error=missing_user_id`
      );
    }

    // Store tokens securely in Vercel KV
    const tokenRecord = {
      ...tokens,
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString(),
      strava_user_id: stravaUserId, // Store Strava user ID with tokens
    };

    // Store in KV with Google user ID as key
    await kv.set(`strava_tokens:${userId}`, tokenRecord);

    // Create mapping from Strava user ID to Google user ID
    console.log(`user id is ${userId}`);
    console.log(
      `storing key: strava_user_mapping:${stravaUserId}; value: ${userId.toString()}`
    );
    await kv.set(`strava_user_mapping:${stravaUserId}`, userId.toString());

    // Mark user as connected
    await kv.set(`strava_connected:${userId}`, true);

    console.log(
      `✅ Strava tokens stored for Google user: ${userId}, Strava user: ${stravaUserId}`
    );

    // Redirect back to frontend with success
    return res.redirect(
      `${
        process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
      }?oura_success=true`
    );
  } catch (error) {
    console.error("❌ Error in Strava OAuth callback:", error);
    return res.redirect(
      `${
        process.env.FRONTEND_URL || "https://oura-calendar-sync.vercel.app"
      }?oura_error=server_error`
    );
  }
}
