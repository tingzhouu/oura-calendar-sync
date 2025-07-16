# 🚀 Firebase-Free Oura Calendar Sync Setup

Welcome to the **simplified, Firebase-free** version! This guide will help you set up everything using just **Vercel** and **direct Google OAuth**.

## 🎯 **What We've Simplified:**

❌ **Removed:**

- Firebase Auth
- Firebase Hosting
- Firebase Firestore
- Complex Firebase configuration

✅ **Using Instead:**

- **Vercel** for hosting + backend
- **Direct Google OAuth** for authentication
- **Vercel KV** for token storage
- **Clean, single-platform** architecture

---

## 📋 **Prerequisites**

1. **Vercel Account**: [vercel.com](https://vercel.com) (free)
2. **Google Cloud Console**: [console.cloud.google.com](https://console.cloud.google.com)
3. **Oura Developer Account**: [cloud.ouraring.com/oauth/applications](https://cloud.ouraring.com/oauth/applications)

---

## 🔧 **Step 1: Google Cloud Setup**

### 1.1 Create Google OAuth App

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Enable **Google Calendar API**:
   - APIs & Services → Library
   - Search "Google Calendar API"
   - Click "Enable"

### 1.2 Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **"+ CREATE CREDENTIALS" → OAuth 2.0 Client IDs**
3. Application type: **Web application**
4. Name: `Oura Calendar Sync`
5. **Authorized redirect URIs**:

   - Add: `https://your-app.vercel.app` (you'll get this after Vercel deployment)
   - Add: `http://localhost:3000` (for local development)

6. **Copy your credentials:**
   - **Client ID**: `123456789-abc.apps.googleusercontent.com`
   - **Client Secret**: `GOCSPX-xyz123abc` (keep secret!)

---

## 🚀 **Step 2: Deploy to Vercel**

### 2.1 Deploy the App

```bash
# Make sure you're in the project directory
cd frontend

# Deploy to Vercel
vercel --prod
```

### 2.2 Add Environment Variables

In **Vercel Dashboard** → Your Project → **Settings** → **Environment Variables**:

| Variable               | Value                              | Notes                      |
| ---------------------- | ---------------------------------- | -------------------------- |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-xyz123abc`                 | From Google Cloud Console  |
| `OURA_CLIENT_SECRET`   | `U4A3732A6TDAFLZZKFYFYPQTGHCPISQJ` | From Oura Developer Portal |

### 2.3 Add Vercel KV Database

1. Go to **Vercel Dashboard** → Your Project
2. Click **Storage** tab
3. Click **Create Database**
4. Select **KV (Redis)**
5. Name: `oura-tokens`
6. Click **Create**

---

## 🔗 **Step 3: Update App Configuration**

### 3.1 Get Your Vercel URL

After deployment, you'll get a URL like:

```
https://oura-calendar-sync-xyz.vercel.app
```

### 3.2 Update Google OAuth Redirect URI

1. Go back to **Google Cloud Console**
2. **APIs & Services → Credentials**
3. Edit your OAuth client
4. **Authorized redirect URIs** → Add:
   ```
   https://oura-calendar-sync-xyz.vercel.app
   ```

### 3.3 Update App Configuration

In your `index.html`, update:

```javascript
// Replace this line:
const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID";

// With your actual Google Client ID:
const GOOGLE_CLIENT_ID = "123456789-abc.apps.googleusercontent.com";
```

### 3.4 Redeploy

```bash
vercel --prod
```

---

## 💍 **Step 4: Oura Setup**

### 4.1 Update Oura App Redirect URI

1. Go to [Oura Developer Portal](https://cloud.ouraring.com/oauth/applications)
2. Edit your app
3. **Redirect URI** → Update to:
   ```
   https://your-actual-vercel-url.vercel.app
   ```

---

## ✅ **Step 5: Test Everything**

### 5.1 Test Google OAuth

1. Visit your Vercel app
2. Click **"Sign in with Google"**
3. Complete OAuth flow
4. Should see: ✅ Google Calendar Connected

### 5.2 Test Oura OAuth

1. After Google sign-in
2. Click **"Connect Oura Ring"**
3. Complete Oura OAuth flow
4. Should see: ✅ Oura Connected

---

## 🔍 **API Endpoints**

Your app provides these endpoints:

- `POST /api/google-auth` - Google OAuth token exchange
- `POST /api/exchange-oura-token` - Oura OAuth token exchange
- `GET /api/get-oura-status` - Check Oura connection status

---

## 🛠️ **Troubleshooting**

### Google OAuth Issues

**Error: "redirect_uri_mismatch"**

- ✅ Make sure redirect URI in Google Cloud Console exactly matches your Vercel URL
- ✅ Include both `https://your-app.vercel.app` and `http://localhost:3000`

**Error: "invalid_client"**

- ✅ Check `GOOGLE_CLIENT_SECRET` environment variable in Vercel
- ✅ Verify Client ID in `index.html` matches Google Cloud Console

### Oura OAuth Issues

**Error: "Invalid redirect_uri"**

- ✅ Update Oura app redirect URI to match your Vercel URL exactly

**Error: "OURA_CLIENT_SECRET not set"**

- ✅ Add `OURA_CLIENT_SECRET` environment variable in Vercel

### Vercel KV Issues

**Error: "KV connection failed"**

- ✅ Make sure you created KV database in Vercel dashboard
- ✅ Database should auto-connect to your project

---

## 💰 **Cost Breakdown**

**Total: $0/month** for personal projects! 🎉

- **Vercel**: Free (100GB bandwidth, 100K function invocations)
- **Vercel KV**: Free (30K operations/month)
- **Google OAuth**: Free
- **Oura API**: Free (personal use)

---

## 🎯 **What's Next?**

After successful setup:

1. ✅ **Google Calendar Access** - Ready for calendar event creation
2. ✅ **Oura Health Data** - Ready to fetch sleep, HRV, activity data
3. ✅ **Secure Token Storage** - All tokens safely stored in Vercel KV
4. 🚀 **Ready for Integration** - Add Oura data → Calendar sync logic

---

## 🔒 **Security Features**

- ✅ **Client secrets** server-side only
- ✅ **OAuth state parameters** prevent CSRF
- ✅ **Encrypted token storage** in Vercel KV
- ✅ **CORS properly configured**
- ✅ **No sensitive data** in frontend

---

## 📞 **Support**

If you need help:

1. **Check Vercel Function Logs**: Vercel Dashboard → Functions → View Logs
2. **Browser Console**: Look for detailed error messages
3. **Network Tab**: Check API request/response details

**Common URLs to verify:**

- Vercel App: `https://your-app.vercel.app`
- Google OAuth: Should redirect back to your app
- Oura OAuth: Should redirect back to your app
