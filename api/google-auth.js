// Vercel Serverless Function: /api/google-auth.js
// Handles Google OAuth token exchange for Calendar access

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
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
    const { code, redirectUri } = req.body;

    if (!code || !redirectUri) {
      return res.status(400).json({
        error: 'Missing required parameters: code, redirectUri'
      });
    }

    // Check if Google client secret is configured
    const GOOGLE_CLIENT_ID = '1001278392320-sd2f6h7dl5pm98vvesdi40o1rcvm0spe.apps.googleusercontent.com'; // Working Client ID
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    
    if (!GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({
        error: 'Server configuration error: GOOGLE_CLIENT_SECRET not set'
      });
    }

    // Exchange authorization code for access token
    const tokenData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      access_type: 'offline',
      approval_prompt: 'force'
    });

    console.log('🔄 Exchanging Google code for tokens...');

    // Make request to Google token endpoint (CORRECT URL)
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenData
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error(`❌ Google token exchange failed: ${tokenResponse.status} - ${errorText}`);
      return res.status(400).json({
        error: 'Token exchange failed',
        details: `Google API returned ${tokenResponse.status}`
      });
    }

    const tokens = await tokenResponse.json();

    // Validate token response
    if (!tokens.access_token) {
      console.error(`❌ Invalid token response from Google:`, tokens);
      return res.status(400).json({
        error: 'Invalid token response from Google'
      });
    }

    // Get user info from Google
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`
      }
    });

    if (!userInfoResponse.ok) {
      return res.status(400).json({
        error: 'Failed to get user info from Google'
      });
    }

    const userInfo = await userInfoResponse.json();
    const userId = userInfo.id;

    // Store Google tokens in KV
    const googleTokenRecord = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      token_type: tokens.token_type || 'Bearer',
      expires_in: tokens.expires_in || 3600,
      scope: tokens.scope || '',
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString()
    };

    await kv.set(`google_tokens:${userId}`, googleTokenRecord);
    
    // Store user profile
    await kv.set(`user_profile:${userId}`, {
      id: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      last_login: new Date().toISOString()
    });

    console.log(`✅ Google tokens stored for user: ${userInfo.email}`);

    // Return user info and success
    return res.status(200).json({
      success: true,
      user: {
        id: userInfo.id,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture
      },
      message: 'Google authentication successful'
    });

  } catch (error) {
    console.error('❌ Error in Google token exchange:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
} 