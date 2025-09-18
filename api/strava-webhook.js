// Vercel Serverless Function: /api/strava-webhook.js
// Handles Strava webhook verification and event processing

import { kv } from "@vercel/kv";

// TTL for webhook events (5 days in seconds)
const WEBHOOK_EVENT_TTL = 5 * 24 * 60 * 60;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const WEBHOOK_VERIFICATION_TOKEN =
    process.env.STRAVA_WEBHOOK_VERIFICATION_TOKEN;

  // Webhook verification (GET request)
  if (req.method === "GET") {
    const { "hub.verify_token": verifyToken, ["hub.challenge"]: hubChallenge } =
      req.query;

    // Verify the token matches our expected token
    if (verifyToken === WEBHOOK_VERIFICATION_TOKEN) {
      console.log("✅ Webhook verification successful");
      return res.json({ ["hub.challenge"]: hubChallenge });
    }

    console.error("❌ Invalid verification token");
    console.error(`verify_token ${verifyToken}`);
    return res.status(401).json({ error: "Invalid verification token" });
  }

  // Webhook event handling (POST request)
  if (req.method === "POST") {
    try {
      const event = req.body;

      // Validate webhook event
      if (
        !event ||
        !event.object_type ||
        !event.object_id ||
        !event.owner_id ||
        !event.aspect_type
      ) {
        console.error("❌ Invalid webhook event:", event);
        return res.status(400).json({ error: "Invalid webhook event" });
      }

      console.log(
        `📥 Received ${event.event_type} event for ${event.data_type} ${event.object_id}`
      );

      // Store the event for processing
      const eventRecord = {
        ...event,
        received_at: new Date().toISOString(),
        processed: false,
      };

      // Store in KV with a unique key and 5-day TTL
      const eventKey = `webhook_event:strava:${event.owner_id}:${event.object_id}:${event.aspect_type}`;

      const alreadyProcessed = await kv.get(eventKey);
      if (alreadyProcessed) {
        console.log(`⚠️ Duplicate webhook ignored: ${eventKey}`);
        return res.status(200).send("Duplicate ignored");
      }

      await kv.set(eventKey, eventRecord, { ex: WEBHOOK_EVENT_TTL });

      // Trigger processing asynchronously
      try {
        console.log(`📥 Triggering async event processing for ${eventKey}`);

        // Use a timeout to ensure we respond quickly while still ensuring the fetch is sent
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Processing trigger timeout")),
            2500
          )
        );

        const processingPromise = fetch(
          `${req.headers["x-forwarded-proto"] || "https"}://${
            req.headers.host
          }/api/process-webhook-event`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ eventKey, source: "strava" }),
          }
        ).then((response) => {
          console.log(
            `✅ Successfully triggered processing for event: ${eventKey}, status: ${response.status}`
          );
          return response;
        });

        // Wait to ensure request is sent, but don't wait for completion
        await Promise.race([processingPromise, timeoutPromise]).catch(
          (error) => {
            if (error.message.includes("timeout")) {
              console.log(
                "⏱️ Processing trigger timed out (request likely sent)"
              );
            } else {
              console.error("❌ Failed to trigger event processing:", error);
            }
          }
        );
      } catch (error) {
        console.error("❌ Error triggering event processing:", error);
      }

      // Respond quickly (under 10 seconds)
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("❌ Error processing webhook:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // Handle unsupported methods
  return res.status(405).json({ error: "Method not allowed" });
}
