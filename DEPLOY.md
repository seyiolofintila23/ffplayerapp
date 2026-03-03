# Deploying FFplayerapp for Free

Your app will be live at: **https://ffplayerapp.onrender.com**
Cost: **£0** — free forever.

Two services used:
- **GitHub** — stores your code (free)
- **Render.com** — runs your app on the internet (free)

---

## Step 1 — Create a GitHub account

1. Go to https://github.com and click **Sign up**
2. Choose a username (e.g. `ffplayerapp`), enter your email and a password
3. Verify your email address

---

## Step 2 — Upload your code to GitHub

1. While logged into GitHub, click the **+** icon (top right) → **New repository**
2. Name it: `ffplayerapp`
3. Set it to **Private** (your players' data stays private)
4. Click **Create repository**
5. On the next page, click the link that says **"uploading an existing file"**
6. Drag and drop ALL the files from your `flair-financials` folder EXCEPT:
   - `node_modules/` folder (don't upload this — it's too large)
   - `data/` folder (don't upload this — it contains your database)
   - `.env` file (don't upload this — it contains your passwords)
7. Click **Commit changes**

Files you SHOULD upload:
```
server.js
database.js
middleware.js
package.json
package-lock.json
render.yaml
.gitignore
.env.example
README.md
public/
  index.html
views/
  admin.html
```

---

## Step 3 — Create a Render account

1. Go to https://render.com and click **Get Started for Free**
2. Click **Continue with GitHub** — this connects Render to your GitHub account
3. Authorise the connection

---

## Step 4 — Deploy on Render

1. In Render's dashboard, click **New +** → **Web Service**
2. Click **Connect** next to your `ffplayerapp` repository
3. Fill in the settings:
   - **Name**: `ffplayerapp`
   - **Region**: `Frankfurt (EU Central)` — closest to UK
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
4. Scroll down to **Environment Variables** and add:

   | Key | Value |
   |-----|-------|
   | `SESSION_SECRET` | (click Generate — Render creates a random one) |
   | `ADMIN_EMAIL` | `your@email.com` (your advisor login email) |
   | `ADMIN_PASSWORD` | (choose a strong password — write it down!) |
   | `NODE_ENV` | `production` |

5. Click **Create Web Service**

Render will now install your app and start it. This takes about 2–3 minutes.

---

## Step 5 — Add a Persistent Disk (keeps your data safe)

Without this, your player data could be lost if Render restarts the app.

1. In your Render service dashboard, click **Disks** in the left menu
2. Click **Add Disk**
3. Set:
   - **Name**: `ffplayerapp-data`
   - **Mount Path**: `/opt/render/project/src/data`
   - **Size**: `1 GB` (free tier allows 1GB)
4. Click **Save** — Render will restart your service

---

## Step 6 — Your app is live!

Once the deploy finishes (green "Live" badge in Render):

| URL | Who uses it |
|-----|-------------|
| `https://ffplayerapp.onrender.com` | Your players — login here |
| `https://ffplayerapp.onrender.com/ffadmin` | You (advisor) — manage everything |

**First login to the advisor panel:**
- Email: whatever you set as `ADMIN_EMAIL`
- Password: whatever you set as `ADMIN_PASSWORD`

Then go to **Add Player** and create accounts for each of your players.
Give them the link `https://ffplayerapp.onrender.com` and their login details.

---

## Important Notes

### Free tier "sleep" behaviour
Render's free tier puts your app to sleep after 15 minutes of no traffic.
The first visit after it sleeps will take ~30 seconds to load. After that it's instant.

To avoid this, you can use a free "uptime" service:
1. Go to https://uptimerobot.com and create a free account
2. Add a new monitor: **HTTP(s)** → URL: `https://ffplayerapp.onrender.com/api/auth/me`
3. Set interval to **5 minutes**
This pings your app every 5 minutes, keeping it awake.

### Updating your app later
When you want to make changes:
1. Edit the files on your computer
2. Upload the changed files to GitHub (go to the file, click the pencil icon, paste new content)
3. Render automatically detects the change and redeploys

### Your admin login
You set this in the Environment Variables on Render.
To change it later: Render dashboard → your service → Environment → edit the values → Save (triggers redeploy).

---

## Cost Summary

| Service | Cost |
|---------|------|
| GitHub (private repo) | Free |
| Render Web Service | Free |
| Render Persistent Disk (1GB) | Free |
| Domain (ffplayerapp.onrender.com) | Free |
| **Total** | **£0/month** |
