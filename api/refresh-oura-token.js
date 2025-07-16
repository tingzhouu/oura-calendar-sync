// Vercel Serverless Function: /api/refresh-oura-token.js
// Refreshes expired Oura access tokens using refresh token

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
    const ouraTokens = await kv.get(`oura_tokens:${userId}`);
    if (!ouraTokens || !ouraTokens.refresh_token) {
      return res.status(400).json({ 
        error: 'No refresh token available',
        reauth_required: true
      });
    }

    // Check if Oura client secret is configured
    const OURA_CLIENT_ID = 'LKNC3TPVJH4ONYAM';
    const OURA_CLIENT_SECRET = process.env.OURA_CLIENT_SECRET;
    
    if (!OURA_CLIENT_SECRET) {
      return res.status(500).json({
        error: 'Server configuration error: OURA_CLIENT_SECRET not set'
      });
    }

    // Refresh the access token
    const refreshData = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: ouraTokens.refresh_token,
      client_id: OURA_CLIENT_ID,
      client_secret: OURA_CLIENT_SECRET
    });

    console.log('🔄 Refreshing Oura access token...');

    const refreshResponse = await fetch('https://api.ouraring.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: refreshData
    });

    if (!refreshResponse.ok) {
      const errorText = await refreshResponse.text();
      console.error(`❌ Oura token refresh failed: ${refreshResponse.status} - ${errorText}`);
      
      // If refresh token is invalid, user needs to re-authenticate
      if (refreshResponse.status === 400) {
        return res.status(400).json({
          error: 'Refresh token expired or invalid',
          reauth_required: true
        });
      }
      
      return res.status(400).json({
        error: 'Token refresh failed',
        details: `Oura API returned ${refreshResponse.status}`
      });
    }

    const newTokens = await refreshResponse.json();

    // Validate token response
    if (!newTokens.access_token) {
      console.error(`❌ Invalid refresh response from Oura:`, newTokens);
      return res.status(400).json({
        error: 'Invalid token response from Oura'
      });
    }

    // Update stored tokens (keep existing refresh token if not provided)
    const updatedTokenRecord = {
      ...ouraTokens,
      access_token: newTokens.access_token,
      token_type: newTokens.token_type || 'Bearer',
      expires_in: newTokens.expires_in || 3600,
      scope: newTokens.scope || ouraTokens.scope,
      last_used: new Date().toISOString(),
      refreshed_at: new Date().toISOString()
    };

    // If a new refresh token is provided, update it
    if (newTokens.refresh_token) {
      updatedTokenRecord.refresh_token = newTokens.refresh_token;
    }

    await kv.set(`oura_tokens:${userId}`, updatedTokenRecord);

    console.log(`✅ Oura access token refreshed for user: ${userId}`);

    return res.status(200).json({
      success: true,
      access_token: newTokens.access_token,
      expires_in: newTokens.expires_in
    });

  } catch (error) {
    console.error('❌ Error refreshing Oura token:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
} 