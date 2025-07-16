// Vercel Serverless Function: /api/exchange-oura-token.js
// Handles secure Oura OAuth token exchange with Vercel KV storage

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  console.log('🔄 Oura token exchange request received');
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    const { code, userId, redirectUri } = req.body;

    // Validate required parameters
    if (!code || !userId || !redirectUri) {
      return res.status(400).json({
        error: 'Missing required parameters: code, userId, redirectUri'
      });
    }

    // Check if client secret is configured
    const OURA_CLIENT_SECRET = process.env.OURA_CLIENT_SECRET;
    if (!OURA_CLIENT_SECRET) {
      return res.status(500).json({
        error: 'Server configuration error: OURA_CLIENT_SECRET not set'
      });
    }

    // Exchange authorization code for access token
    const tokenData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: 'LKNC3TPVJH4ONYAM', // Your Oura client ID
      client_secret: OURA_CLIENT_SECRET
    });

    console.log(`🔄 Exchanging Oura code for tokens for user: ${userId}`);

    // Make request to Oura token endpoint
    const tokenResponse = await fetch('https://api.ouraring.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenData
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(`❌ Oura token exchange failed: ${tokenResponse.status} - ${errorText}`);
      return res.status(400).json({
        error: 'Token exchange failed',
        details: `Oura API returned ${tokenResponse.status}`
      });
    }

    const tokens = await tokenResponse.json();

    // Validate token response
    if (!tokens.access_token) {
      console.error(`❌ Invalid token response from Oura:`, tokens);
      return res.status(400).json({
        error: 'Invalid token response from Oura'
      });
    }

    // Store tokens securely in Vercel KV
    const tokenRecord = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      token_type: tokens.token_type || 'Bearer',
      expires_in: tokens.expires_in || 3600,
      scope: tokens.scope || '',
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString()
    };

    // Store in KV with user-specific key
    await kv.set(`oura_tokens:${userId}`, tokenRecord);
    
    // Also mark user as connected
    await kv.set(`oura_connected:${userId}`, true);
    
    console.log(`✅ Oura tokens stored in KV for user: ${userId}`);

    // Return success (no tokens in response for security)
    return res.status(200).json({
      success: true,
      message: 'Oura account connected successfully',
      connected_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error in Oura token exchange:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
} 