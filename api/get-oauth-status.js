// Vercel Serverless Function: /api/get-oura-status.js
// Check if user has connected Oura account

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Allow GET and POST requests
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Get user ID from query params or request body
    let userId = null;
    if (req.method === "GET") {
      userId = req.query.userId;
    } else {
      // POST
      const requestData = req.body;
      if (requestData) {
        userId = requestData.userId;
      }
    }

    if (!userId) {
      return res.status(400).json({
        error: "Missing userId parameter",
      });
    }

    // Check KV for user's Strava connection status
    const stravaTokens = await kv.get(`strava_tokens:${userId}`);
    const ouraTokens = await kv.get(`oura_tokens:${userId}`);

    console.log(
      `Strava tokens with key strava_tokens:${userId}: ${stravaTokens?.token_type}`
    );

    return res.status(200).json({
      oura: {
        connected: Boolean(ouraTokens),
        last_sync: ouraTokens?.last_used || null,
      },
      strava: {
        connected: Boolean(stravaTokens),
        last_sync: stravaTokens?.last_used || null,
      },
    });
  } catch (error) {
    console.error("❌ Error checking Strava status:", error);
    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
