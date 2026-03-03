# ⚽ FFplayerapp — Player Portal

A secure, self-hosted financial management platform for football agencies. Players log in to track their income, expenses, and savings goals. Advisors use the advisor panel to manage all accounts.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env to set your SESSION_SECRET and admin credentials

# 3. Start the server
npm start
```

On first run, an admin account is automatically created from your `.env` values.

- **Player Portal** → http://localhost:3000
- **Advisor Panel** → http://localhost:3000/ffadmin

---

## Default Admin Login

| Field    | Value                              |
|----------|------------------------------------|
| Email    | `admin@ffplayerapp.com`            |
| Password | `changeme123`                      |

**Change this immediately after first login via the Security tab in the Admin Panel.**

---

## Environment Variables (.env)

| Variable          | Description                              | Default                        |
|-------------------|------------------------------------------|--------------------------------|
| `SESSION_SECRET`  | Secret key for signing session cookies   | `dev-secret-please-change...`  |
| `PORT`            | Port the server listens on               | `3000`                         |
| `ADMIN_EMAIL`     | First admin email (seeded on first run)  | `admin@flairfinancials.co.uk`  |
| `ADMIN_PASSWORD`  | First admin password (seeded on first run) | `changeme123`               |

---

## Project Structure

```
flair-financials/
├── server.js        # Express server — all API routes
├── database.js      # SQLite schema, queries, seed
├── middleware.js    # requireAuth, requireAdmin
├── package.json
├── .env             # Your config (gitignored)
├── .env.example     # Config template
├── public/
│   ├── index.html   # Player portal (login + 4 tabs)
│   └── admin.html   # Advisor admin panel
└── data/
    └── flair.db     # SQLite database (auto-created)
```

---

## Feature Overview

### Player Portal (`/`)
- **Overview** — Hero card, stat widgets, weekly spend vs budget chart, spending donut, recent expenses
- **Spending** — Category breakdown table + charts (weekly vs monthly)
- **Add Expense** — Log expenses with category, amount, date, method; live budget bars
- **Savings & Goals** — Progress bars per goal, add new goals, update progress

### Admin Panel (`/admin.html`)
- **Players** — Grid of all players with key stats; click to manage
- **Add Player** — Create account with profile, wage, and initial budgets in one form
- **Player Detail Slide Panel:**
  - **Profile** — Edit name, email, club, position, wage, DOB
  - **Budget** — Set weekly spending limits per category
  - **Income** — Log monthly gross/net income records
  - **Expenses** — View, add, and delete any player expense
  - **Goals** — Add, update, and delete savings goals
  - **Security** — Reset player password

---

## VPS Deployment

### 1. Install Node.js

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 18
```

### 2. Upload project & install

```bash
git clone <your-repo> /opt/flair-financials
cd /opt/flair-financials
npm install
cp .env.example .env
nano .env  # Set SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
```

### 3. Run with PM2 (auto-restart on reboot)

```bash
npm install -g pm2
pm2 start server.js --name flair-financials
pm2 save
pm2 startup  # follow the printed command
```

### 4. Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name portal.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 5. Free SSL with Certbot

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d portal.yourdomain.com
```

After SSL is set up, add `NODE_ENV=production` to your `.env` — this enables secure cookies.

---

## Security Notes

- All passwords are hashed with **bcrypt** (cost factor 12)
- Sessions stored server-side in SQLite — cookies are `httpOnly`, `sameSite: lax`
- Every player query enforces `user_id` from the session — players cannot see each other's data
- All input is validated server-side before touching the database
- Prepared statements throughout — no SQL injection risk
- Players cannot access admin routes (role check on every admin endpoint)

---

## Database Backup

The entire database is a single file: `data/flair.db`

```bash
# Simple backup
cp data/flair.db backups/flair-$(date +%Y%m%d).db

# Cron job for daily backups
0 2 * * * cp /opt/flair-financials/data/flair.db /opt/backups/flair-$(date +\%Y\%m\%d).db
```
