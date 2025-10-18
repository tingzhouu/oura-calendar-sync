// Vercel Serverless Function: /api/subscribe-oura-webhooks.js
// Manages Oura webhook subscriptions

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Check if Oura client credentials are configured
    const OURA_CLIENT_ID = process.env.OURA_CLIENT_ID;
    const OURA_CLIENT_SECRET = process.env.OURA_CLIENT_SECRET;
    const WEBHOOK_VERIFICATION_TOKEN = process.env.OURA_WEBHOOK_VERIFICATION_TOKEN;

    if (!OURA_CLIENT_SECRET || !WEBHOOK_VERIFICATION_TOKEN) {
      console.error('❌ Missing Oura credentials');
      return res.status(500).json({
        error: 'Server configuration error: Missing Oura credentials'
      });
    }

    // Get the base URL for our webhook endpoint
    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const webhookUrl = `${baseUrl}/api/oura-webhook`;

    // Define the data types we want to subscribe to
    const dataTypes = ['sleep', 'workout', 'session'];
    const eventType = 'create'; // We only want create events

    console.log('🔄 Setting up Oura webhook subscriptions...');

    // Create subscriptions for each data type
    const subscriptionPromises = dataTypes.map(async (dataType) => {
      const subscriptionData = {
        callback_url: webhookUrl,
        verification_token: WEBHOOK_VERIFICATION_TOKEN,
        event_type: eventType,
        data_type: dataType
      };

      // Make request to Oura webhook subscription endpoint
      const response = await fetch('https://api.ouraring.com/v2/webhook/subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': OURA_CLIENT_ID,
          'x-client-secret': OURA_CLIENT_SECRET
        },
        body: JSON.stringify(subscriptionData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to subscribe to ${dataType} webhooks: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log(`✅ Subscribed to ${dataType} webhooks:`, result);
      return { dataType, success: true, subscription: result };
    });

    // Wait for all subscriptions to complete
    const results = await Promise.allSettled(subscriptionPromises);

    // Check results and prepare response
    const subscriptionResults = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        console.error(`❌ Failed to subscribe to ${dataTypes[index]}:`, result.reason);
        return {
          dataType: dataTypes[index],
          success: false,
          error: result.reason.message
        };
      }
    });

    // Store webhook configuration status in KV
    const allSuccessful = subscriptionResults.every(result => result.success);
    if (allSuccessful) {
      // Extract user ID from Authorization header or query param
      const userId = req.headers.authorization || req.query.userId;
      if (userId) {
        await kv.set(`oura_webhooks:${userId}`, {
          configured_at: new Date().toISOString(),
          subscriptions: subscriptionResults
        });
      }
    }

    // Return results
    return res.status(200).json({
      success: true,
      subscriptions: subscriptionResults
    });

  } catch (error) {
    console.error('❌ Error setting up webhook subscriptions:', error);
    return res.status(500).json({
      error: 'Failed to set up webhook subscriptions',
      details: error.message
    });
  }
} 