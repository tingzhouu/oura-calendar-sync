// Vercel Serverless Function: /api/get-oura-status.js
// Check if user has connected Oura account

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

  // Allow GET and POST requests
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get user ID from query params or request body
    let userId = null;
    if (req.method === 'GET') {
      userId = req.query.userId;
    } else {  // POST
      const requestData = req.body;
      if (requestData) {
        userId = requestData.userId;
      }
    }

    if (!userId) {
      return res.status(400).json({
        error: 'Missing userId parameter'
      });
    }

    // Check KV for user's Oura connection status
    const isConnected = await kv.get(`oura_connected:${userId}`);
    const tokens = await kv.get(`oura_tokens:${userId}`);

    return res.status(200).json({
      connected: Boolean(isConnected && tokens),
      last_sync: tokens?.last_used || null
    });

  } catch (error) {
    console.error('❌ Error checking Oura status:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
} 