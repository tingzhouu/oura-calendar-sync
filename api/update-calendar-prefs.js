// Vercel Serverless Function: /api/update-calendar-prefs.js
// Manages user's calendar preferences for different Oura data types

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

  // Handle GET request to fetch preferences
  if (req.method === 'GET') {
    try {
      const userId = req.query.userId;
      if (!userId) {
        return res.status(400).json({ error: 'Missing userId parameter' });
      }

      // Get current preferences
      const prefs = await kv.get(`calendar_prefs:${userId}`);
      
      // Get list of available calendars
      const googleTokens = await kv.get(`google_tokens:${userId}`);
      if (!googleTokens?.access_token) {
        return res.status(400).json({ error: 'Google tokens not found' });
      }

      let calendarsResponse = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: {
          'Authorization': `Bearer ${googleTokens.access_token}`
        }
      });

      // If token expired, try to refresh and retry
      if (calendarsResponse.status === 401) {
        console.log('🔄 Access token expired, attempting refresh...');
        
        const refreshResponse = await fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/refresh-google-token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ userId })
        });

        if (refreshResponse.ok) {
          const refreshResult = await refreshResponse.json();
          console.log('✅ Token refreshed successfully, retrying calendar list fetch');
          
          // Retry with new token
          calendarsResponse = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
            headers: {
              'Authorization': `Bearer ${refreshResult.access_token}`
            }
          });
        } else {
          const refreshError = await refreshResponse.json();
          if (refreshError.reauth_required) {
            return res.status(401).json({ 
              error: 'Google authentication expired',
              reauth_required: true 
            });
          }
          throw new Error('Failed to refresh access token');
        }
      }

      if (!calendarsResponse.ok) {
        throw new Error(`Failed to fetch calendars: ${calendarsResponse.status} ${calendarsResponse.statusText}`);
      }

      const calendars = await calendarsResponse.json();
      
      return res.status(200).json({
        preferences: prefs || {
          sleep: 'primary',
          workout: 'primary',
          session: 'primary'
        },
        calendars: calendars.items.map(cal => ({
          id: cal.id,
          summary: cal.summary,
          primary: cal.primary || false
        }))
      });

    } catch (error) {
      console.error('❌ Error fetching calendar preferences:', error);
      return res.status(500).json({ error: `Failed to fetch preferences: ${error.message}` });
    }
  }

  // Handle POST request to update preferences
  if (req.method === 'POST') {
    try {
      const { userId, preferences } = req.body;
      
      if (!userId || !preferences) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }

      // Validate preferences
      const validTypes = ['sleep', 'workout', 'session'];
      for (const type of validTypes) {
        if (!preferences[type]) {
          return res.status(400).json({ error: `Missing calendar preference for ${type}` });
        }
      }

      // Get user's Google tokens to verify calendars exist
      const googleTokens = await kv.get(`google_tokens:${userId}`);
      if (!googleTokens?.access_token) {
        return res.status(400).json({ error: 'Google tokens not found' });
      }

      // Verify all calendars exist and are accessible
      const calendarIds = [...new Set(Object.values(preferences))];
      let currentAccessToken = googleTokens.access_token;
      
      for (const calendarId of calendarIds) {
        if (calendarId !== 'primary') {
          let response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, {
            headers: {
              'Authorization': `Bearer ${currentAccessToken}`
            }
          });

          // If token expired, try to refresh and retry
          if (response.status === 401) {
            console.log('🔄 Access token expired during calendar verification, attempting refresh...');
            
            const refreshResponse = await fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/refresh-google-token`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ userId })
            });

            if (refreshResponse.ok) {
              const refreshResult = await refreshResponse.json();
              currentAccessToken = refreshResult.access_token;
              console.log('✅ Token refreshed successfully, retrying calendar verification');
              
              // Retry with new token
              response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, {
                headers: {
                  'Authorization': `Bearer ${currentAccessToken}`
                }
              });
            } else {
              const refreshError = await refreshResponse.json();
              if (refreshError.reauth_required) {
                return res.status(401).json({ 
                  error: 'Google authentication expired',
                  reauth_required: true 
                });
              }
              throw new Error('Failed to refresh access token');
            }
          }

          if (!response.ok) {
            return res.status(400).json({ error: `Invalid calendar ID: ${calendarId}` });
          }
        }
      }

      // Store preferences
      await kv.set(`calendar_prefs:${userId}`, preferences);

      return res.status(200).json({
        success: true,
        preferences
      });

    } catch (error) {
      console.error('❌ Error updating calendar preferences:', error);
      return res.status(500).json({ error: 'Failed to update preferences' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
} 