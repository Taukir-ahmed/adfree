# CleanPlay Web — Standalone Cloud & Mobile Video Player

CleanPlay Web runs **24/7 in the cloud on Vercel** so you can watch TeraBox videos, series, and folders on your phone (**Mobile Safari or Chrome**) without keeping your laptop on.

---

## ⚡ 1-Minute Deployment to Vercel (Free 24/7 Hosting)

Because you already have a **Vercel** account, you can deploy this in two ways:

### Option A: Via GitHub (Recommended)
1. Initialize a git repo in the `webapp` folder or push it to your GitHub:
   ```bash
   cd c:\Users\rockt\Downloads\cleanplay-v3\webapp
   git init
   git add .
   git commit -m "CleanPlay Web App"
   ```
2. Push to a private or public repository on your GitHub.
3. Go to [vercel.com/new](https://vercel.com/new), select your GitHub repository, and click **Deploy**.
4. That's it! Vercel will give you a live URL like:
   `https://cleanplay-yourname.vercel.app`

### Option B: Via Vercel CLI
1. Open PowerShell / Terminal in `webapp`:
   ```bash
   cd c:\Users\rockt\Downloads\cleanplay-v3\webapp
   npx vercel
   ```
2. Follow the 3 prompts (log in with your Vercel account, accept defaults).
3. It will deploy your site in ~30 seconds and output your live production URL.

---

## 📱 Use on Mobile (Zero Laptop Needed)

Once deployed to Vercel:
1. Open your Vercel URL (e.g., `https://cleanplay-yourname.vercel.app`) on your phone (**Safari on iOS** or **Chrome on Android**).
2. **Add to Home Screen**:
   - **iPhone (Safari):** Tap **Share (`⎋`)** ➔ **Add to Home Screen**.
   - **Android (Chrome):** Tap **Menu (`⋮`)** ➔ **Add to Home screen**.
3. It now opens full-screen like a native app. Paste any TeraBox folder or video link and watch ad-free!

---

## 🗄️ What about Supabase?

- **Is Supabase required?**
  No — Vercel runs the serverless resolver and HLS stream proxy 100% standalone. Recent links are stored right on your phone in `localStorage`.
- **Can we connect Supabase?**
  Yes! If you want your watch history, bookmarked folders, and playback progress to sync automatically between your phone and laptop, we can connect your Supabase database (`@supabase/supabase-js`) to store user accounts and cloud bookmarks.

---

## 💻 Local Testing (Optional)

If you ever want to run it locally on your computer instead:
```bash
cd c:\Users\rockt\Downloads\cleanplay-v3\webapp
node server.js
```
