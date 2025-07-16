// Vercel Serverless Function: /api/oura-callback.js  
// Handles Oura OAuth callback directly - receives code, exchanges for tokens, redirects to frontend

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  console.log('🔄 Oura OAuth callback received');

  try {
    // Get OAuth parameters from query string
    const { code, state, error } = req.query;

    // Handle OAuth errors
    if (error) {
      console.error('❌ Oura OAuth error:', error);
      return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=${encodeURIComponent(error)}`);
    }

    // Validate required parameters
    if (!code || !state) {
      console.error('❌ Missing code or state in Oura callback');
      return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=missing_parameters`);
    }

    // Get user ID from state (we'll need to store this when initiating OAuth)
    // For now, we'll extract it from the state parameter
    let userId;
    try {
      // State format: "userId:randomString" 
      userId = state.split(':')[0];
      if (!userId) {
        throw new Error('Invalid state format');
      }
    } catch (err) {
      console.error('❌ Invalid state parameter:', state);
      return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=invalid_state`);
    }

    // Check if Oura client secret is configured
    const OURA_CLIENT_SECRET = process.env.OURA_CLIENT_SECRET;
    if (!OURA_CLIENT_SECRET) {
      console.error('❌ OURA_CLIENT_SECRET not configured');
      return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=server_config`);
    }

    // Exchange authorization code for access token
    const tokenData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/oura-callback`,
      client_id: 'LKNC3TPVJH4ONYAM', // Oura client ID
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
      return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=token_exchange_failed`);
    }

    const tokens = await tokenResponse.json();

    // Validate token response
    if (!tokens.access_token) {
      console.error(`❌ Invalid token response from Oura:`, tokens);
      return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=invalid_tokens`);
    }

    // Get Oura user ID from personal info API
    const personalInfoResponse = await fetch('https://api.ouraring.com/v2/usercollection/personal_info', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`
      }
    });

    if (!personalInfoResponse.ok) {
      console.error(`❌ Failed to fetch Oura user info: ${personalInfoResponse.status}`);
      return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=user_info_failed`);
    }

    const personalInfo = await personalInfoResponse.json();
    const ouraUserId = personalInfo.id;

    if (!ouraUserId) {
      console.error('❌ No Oura user ID in personal info response');
      return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=missing_user_id`);
    }

    // Store tokens securely in Vercel KV
    const tokenRecord = {
      ...tokens,
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString(),
      oura_user_id: ouraUserId // Store Oura user ID with tokens
    };

    // Store in KV with Google user ID as key
    await kv.set(`oura_tokens:${userId}`, tokenRecord);
    
    // Create mapping from Oura user ID to Google user ID
    await kv.set(`oura_user_mapping:${ouraUserId}`, userId);
    
    // Mark user as connected
    await kv.set(`oura_connected:${userId}`, true);
    
    console.log(`✅ Oura tokens stored for Google user: ${userId}, Oura user: ${ouraUserId}`);

    // Redirect back to frontend with success
    return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_success=true`);

  } catch (error) {
    console.error('❌ Error in Oura OAuth callback:', error);
    return res.redirect(`${process.env.FRONTEND_URL || 'https://oura-calendar-sync.vercel.app'}?oura_error=server_error`);
  }
} 