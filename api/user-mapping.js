// Vercel Serverless Function: /api/user-mapping.js
// Manages and debugs Oura to Google user ID mappings

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

  // Handle GET request to get mapping info
  if (req.method === 'GET') {
    try {
      const { googleUserId, ouraUserId } = req.query;

      if (googleUserId) {
        // Get Oura tokens and mapping for Google user
        const ouraTokens = await kv.get(`oura_tokens:${googleUserId}`);
        const connected = await kv.get(`oura_connected:${googleUserId}`);
        
        return res.status(200).json({
          googleUserId,
          ouraUserId: ouraTokens?.oura_user_id || null,
          connected: Boolean(connected),
          hasTokens: Boolean(ouraTokens),
          tokenCreated: ouraTokens?.created_at || null
        });
      }

      if (ouraUserId) {
        // Get Google user mapping for Oura user
        const googleUserId = await kv.get(`oura_user_mapping:${ouraUserId}`);
        
        if (googleUserId) {
          const ouraTokens = await kv.get(`oura_tokens:${googleUserId}`);
          const googleTokens = await kv.get(`google_tokens:${googleUserId}`);
          
          return res.status(200).json({
            ouraUserId,
            googleUserId,
            hasOuraTokens: Boolean(ouraTokens),
            hasGoogleTokens: Boolean(googleTokens),
            tokenCreated: ouraTokens?.created_at || null
          });
        } else {
          return res.status(404).json({
            ouraUserId,
            error: 'No Google user mapping found'
          });
        }
      }

      return res.status(400).json({ error: 'Provide either googleUserId or ouraUserId parameter' });

    } catch (error) {
      console.error('❌ Error getting user mapping:', error);
      return res.status(500).json({ error: 'Failed to get user mapping' });
    }
  }

  // Handle POST request to manually create/update mapping
  if (req.method === 'POST') {
    try {
      const { googleUserId, ouraUserId, action } = req.body;

      if (!googleUserId || !ouraUserId) {
        return res.status(400).json({ error: 'Missing googleUserId or ouraUserId' });
      }

      if (action === 'create') {
        // Create new mapping
        await kv.set(`oura_user_mapping:${ouraUserId}`, googleUserId);
        
        // Update Oura tokens to include the Oura user ID
        const ouraTokens = await kv.get(`oura_tokens:${googleUserId}`);
        if (ouraTokens) {
          await kv.set(`oura_tokens:${googleUserId}`, {
            ...ouraTokens,
            oura_user_id: ouraUserId,
            mapping_updated: new Date().toISOString()
          });
        }

        return res.status(200).json({
          success: true,
          message: 'Mapping created',
          googleUserId,
          ouraUserId
        });
      }

      if (action === 'delete') {
        // Delete mapping
        await kv.del(`oura_user_mapping:${ouraUserId}`);
        
        return res.status(200).json({
          success: true,
          message: 'Mapping deleted',
          ouraUserId
        });
      }

      return res.status(400).json({ error: 'Invalid action. Use "create" or "delete"' });

    } catch (error) {
      console.error('❌ Error managing user mapping:', error);
      return res.status(500).json({ error: 'Failed to manage user mapping' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
} 