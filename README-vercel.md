# 🚀 Oura Calendar Sync - Vercel Backend Setup

This guide helps you deploy the backend API to Vercel (100% free) instead of using Firebase Functions.

## 📋 Prerequisites

1. **Vercel Account**: Sign up at [vercel.com](https://vercel.com) (free)
2. **GitHub Account**: To connect your repository
3. **Oura Developer App**: Your client ID and secret

## 🎯 Step 1: Get Your Oura Client Secret

1. Go to [Oura Developer Portal](https://cloud.ouraring.com/oauth/applications)
2. Click on your app
3. Copy the **Client Secret** (keep this safe!)

## 🚀 Step 2: Deploy to Vercel

### Option A: Deploy via GitHub (Recommended)

1. **Push your code to GitHub**:

   ```bash
   git add .
   git commit -m "Add Vercel backend API"
   git push origin main
   ```

2. **Connect to Vercel**:
   - Go to [vercel.com/new](https://vercel.com/new)
   - Import your GitHub repository
   - Click "Deploy"

### Option B: Deploy via Vercel CLI

1. **Install Vercel CLI**:

   ```bash
   npm i -g vercel
   ```

2. **Login and deploy**:
   ```bash
   vercel login
   vercel --prod
   ```

## 🔧 Step 3: Set Environment Variables

1. **In Vercel Dashboard**:

   - Go to your project → Settings → Environment Variables
   - Add: `OURA_CLIENT_SECRET` = `your_actual_client_secret`

2. **Or via CLI**:
   ```bash
   vercel env add OURA_CLIENT_SECRET
   # Paste your client secret when prompted
   ```

## 🌐 Step 4: Update Frontend

1. **Get your Vercel URL** (e.g., `https://your-app.vercel.app`)

2. **Update the frontend**:
   - Replace `YOUR_VERCEL_APP` in `public/index.html` with your actual Vercel URL
   - Search for: `https://YOUR_VERCEL_APP.vercel.app`
   - Replace with: `https://your-actual-app.vercel.app`

## 🔗 Step 5: Update Oura App Redirect URI

1. Go to your **Oura Developer App**
2. Add redirect URI: `https://oura-calendar-sync.web.app/oura-callback`
3. Save changes

## ✅ Step 6: Test the Integration

1. **Deploy updated frontend**:

   ```bash
   firebase deploy --only hosting
   ```

2. **Test the flow**:
   - Visit your Firebase hosted app
   - Sign in with Google
   - Click "Connect Oura"
   - Complete OAuth flow
   - Check if connection succeeds

## 🔍 API Endpoints

Your Vercel deployment provides these endpoints:

- `POST /api/exchange-oura-token` - Exchange OAuth code for tokens
- `GET /api/health` - Health check (optional)

## 🛠️ Troubleshooting

### "OURA_CLIENT_SECRET not set"

- Double-check environment variable is set in Vercel dashboard
- Redeploy after adding environment variables

### "Token exchange failed"

- Verify your client secret is correct
- Check Oura app redirect URI matches exactly
- Look at Vercel function logs for details

### CORS errors

- The API includes CORS headers
- Check network tab for actual error details

## 💡 Next Steps

After successful deployment:

1. ✅ Oura OAuth now works with secure backend
2. ✅ Tokens stored safely in Firestore
3. ✅ Ready to add Oura data fetching
4. ✅ Ready to sync with Google Calendar

## 📊 Cost Breakdown

- **Vercel**: Free (100GB bandwidth, 100 function invocations/day)
- **Firebase Hosting**: Free (10GB storage, 360MB/day transfer)
- **Firebase Firestore**: Free (1GB storage, 50K reads/day)

**Total: $0/month** for personal projects! 🎉

## 🔒 Security Notes

- ✅ Client secret stays server-side only
- ✅ Tokens encrypted in Firestore
- ✅ CORS properly configured
- ✅ Environment variables secure
