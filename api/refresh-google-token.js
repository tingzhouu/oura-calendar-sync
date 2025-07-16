// Vercel Serverless Function: /api/refresh-google-token.js
// Refreshes expired Google access tokens using refresh token

import { kv } from '@vercel/kv';

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
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId parameter' });
    }

    // Get current tokens
    const googleTokens = await kv.get(`google_tokens:${userId}`);
    if (!googleTokens || !googleTokens.refresh_token) {
      return res.status(400).json({ 
        error: 'No refresh token available',
        reauth_required: true
      });
    }

    // Check if Google client secret is configured
    const GOOGLE_CLIENT_ID = '1001278392320-sd2f6h7dl5pm98vvesdi40o1rcvm0spe.apps.googleusercontent.com';
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    
    if (!GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({
        error: 'Server configuration error: GOOGLE_CLIENT_SECRET not set'
      });
    }

    // Refresh the access token
    const refreshData = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: googleTokens.refresh_token,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET
    });

    console.log('🔄 Refreshing Google access token...');

    const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: refreshData
    });

    if (!refreshResponse.ok) {
      const errorText = await refreshResponse.text();
      console.error(`❌ Token refresh failed: ${refreshResponse.status} - ${errorText}`);
      
      // If refresh token is invalid, user needs to re-authenticate
      if (refreshResponse.status === 400) {
        return res.status(400).json({
          error: 'Refresh token expired or invalid',
          reauth_required: true
        });
      }
      
      return res.status(400).json({
        error: 'Token refresh failed',
        details: `Google API returned ${refreshResponse.status}`
      });
    }

    const newTokens = await refreshResponse.json();

    // Validate token response
    if (!newTokens.access_token) {
      console.error(`❌ Invalid refresh response from Google:`, newTokens);
      return res.status(400).json({
        error: 'Invalid token response from Google'
      });
    }

    // Update stored tokens (keep existing refresh token if not provided)
    const updatedTokenRecord = {
      ...googleTokens,
      access_token: newTokens.access_token,
      token_type: newTokens.token_type || 'Bearer',
      expires_in: newTokens.expires_in || 3600,
      scope: newTokens.scope || googleTokens.scope,
      last_used: new Date().toISOString(),
      refreshed_at: new Date().toISOString()
    };

    // If a new refresh token is provided, update it
    if (newTokens.refresh_token) {
      updatedTokenRecord.refresh_token = newTokens.refresh_token;
    }

    await kv.set(`google_tokens:${userId}`, updatedTokenRecord);

    console.log(`✅ Google access token refreshed for user: ${userId}`);

    return res.status(200).json({
      success: true,
      access_token: newTokens.access_token,
      expires_in: newTokens.expires_in
    });

  } catch (error) {
    console.error('❌ Error refreshing Google token:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
} 