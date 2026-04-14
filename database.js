require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const dbUrl = new URL(process.env.DATABASE_URL.replace(/\s+/g, ''));
const pool = new Pool({
  host:     dbUrl.hostname,
  port:     parseInt(dbUrl.port) || 5432,
  database: dbUrl.pathname.slice(1),
  user:     dbUrl.username,
  password: dbUrl.password,
  ssl:      process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id               SERIAL PRIMARY KEY,
      email            TEXT    NOT NULL UNIQUE,
      password_hash    TEXT    NOT NULL,
      role             TEXT    NOT NULL DEFAULT 'player',
      name             TEXT    NOT NULL,
      club             TEXT,
      position         TEXT,
      monthly_wage_net REAL    DEFAULT 0,
      born             TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date            TEXT    NOT NULL,
      description     TEXT    NOT NULL,
      amount          REAL    NOT NULL,
      category        TEXT    NOT NULL,
      payment_method  TEXT    DEFAULT 'Card',
      notes           TEXT    DEFAULT '',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category     TEXT    NOT NULL,
      monthly_limit REAL   NOT NULL DEFAULT 0,
      UNIQUE(user_id, category)
    );

    CREATE TABLE IF NOT EXISTS savings_goals (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name           TEXT    NOT NULL,
      icon           TEXT    DEFAULT '🎯',
      target_amount  REAL    NOT NULL DEFAULT 0,
      current_amount REAL    NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS income_records (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month         INTEGER NOT NULL,
      year          INTEGER NOT NULL,
      gross_monthly REAL    DEFAULT 0,
      net_monthly   REAL    DEFAULT 0,
      agent_fee_pct REAL    DEFAULT 0,
      notes         TEXT    DEFAULT '',
      UNIQUE(user_id, month, year)
    );

    CREATE TABLE IF NOT EXISTS onboarding_leads (
      id                  SERIAL PRIMARY KEY,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      first_name          TEXT NOT NULL,
      last_name           TEXT NOT NULL,
      age                 INTEGER,
      nationality         TEXT,
      email               TEXT NOT NULL,
      phone               TEXT,
      club                TEXT,
      position            TEXT,
      league              TEXT,
      weekly_wage         INTEGER DEFAULT 0,
      contract_end        TEXT,
      contract_type       TEXT,
      extra_income        TEXT DEFAULT '',
      has_advisor         TEXT,
      spending_style      TEXT,
      spending_categories TEXT DEFAULT '',
      monthly_savings     INTEGER DEFAULT 0,
      goals               TEXT DEFAULT '',
      concerns            TEXT DEFAULT '',
      priority_text       TEXT DEFAULT '',
      heard_via           TEXT,
      status              TEXT DEFAULT 'new'
    );
  `);

  // ─── MIGRATIONS ──────────────────────────────────────────────────────────────
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='weekly_wage_net') THEN
        ALTER TABLE users RENAME COLUMN weekly_wage_net TO monthly_wage_net;
        UPDATE users SET monthly_wage_net = ROUND((monthly_wage_net * 52 / 12)::numeric, 2);
      END IF;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='budgets' AND column_name='weekly_limit') THEN
        ALTER TABLE budgets RENAME COLUMN weekly_limit TO monthly_limit;
        UPDATE budgets SET monthly_limit = ROUND((monthly_limit * 52 / 12)::numeric, 2);
      END IF;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='income_records' AND column_name='gross_weekly') THEN
        ALTER TABLE income_records RENAME COLUMN gross_weekly TO gross_monthly;
        ALTER TABLE income_records RENAME COLUMN net_weekly TO net_monthly;
        UPDATE income_records SET gross_monthly = ROUND((gross_monthly * 52 / 12)::numeric, 2),
                                  net_monthly   = ROUND((net_monthly   * 52 / 12)::numeric, 2);
      END IF;
    END $$;
  `);
}

// ─── QUERY HELPERS ────────────────────────────────────────────────────────────

const q = {
  // Users
  async getUserByEmail(email) {
    return (await pool.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  },
  async getUserById(id) {
    return (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  },
  async getAllPlayers() {
    return (await pool.query(
      "SELECT id, email, name, club, position, monthly_wage_net, born, created_at FROM users WHERE role='player' ORDER BY name"
    )).rows;
  },
  async createUser(email, password_hash, role, name, club, position, monthly_wage_net, born) {
    return (await pool.query(
      'INSERT INTO users (email, password_hash, role, name, club, position, monthly_wage_net, born) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [email, password_hash, role, name, club, position, monthly_wage_net, born]
    )).rows[0];
  },
  async updateUser(name, email, club, position, monthly_wage_net, born, id) {
    await pool.query(
      'UPDATE users SET name=$1, email=$2, club=$3, position=$4, monthly_wage_net=$5, born=$6 WHERE id=$7',
      [name, email, club, position, monthly_wage_net, born, id]
    );
  },
  async updatePassword(password_hash, id) {
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [password_hash, id]);
  },
  async deleteUser(id) {
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
  },

  // Expenses
  async getExpensesByUser(user_id) {
    return (await pool.query(
      'SELECT * FROM expenses WHERE user_id=$1 ORDER BY date DESC, created_at DESC', [user_id]
    )).rows;
  },
  async getExpensesByUserAdmin(user_id) {
    return (await pool.query(
      'SELECT * FROM expenses WHERE user_id=$1 ORDER BY date DESC', [user_id]
    )).rows;
  },
  async addExpense(user_id, date, description, amount, category, payment_method, notes) {
    return (await pool.query(
      'INSERT INTO expenses (user_id, date, description, amount, category, payment_method, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [user_id, date, description, amount, category, payment_method, notes]
    )).rows[0];
  },
  async deleteExpenseOwn(id, user_id) {
    return (await pool.query('DELETE FROM expenses WHERE id=$1 AND user_id=$2', [id, user_id])).rowCount;
  },
  async deleteExpenseAdmin(id) {
    return (await pool.query('DELETE FROM expenses WHERE id=$1', [id])).rowCount;
  },

  // Budgets
  async getBudgetsByUser(user_id) {
    return (await pool.query('SELECT * FROM budgets WHERE user_id=$1', [user_id])).rows;
  },
  async upsertBudget(user_id, category, monthly_limit) {
    await pool.query(
      'INSERT INTO budgets (user_id, category, monthly_limit) VALUES ($1,$2,$3) ON CONFLICT (user_id, category) DO UPDATE SET monthly_limit=$3',
      [user_id, category, monthly_limit]
    );
  },
  async deleteBudgetsByUser(user_id) {
    await pool.query('DELETE FROM budgets WHERE user_id=$1', [user_id]);
  },

  // Savings goals
  async getSavingsByUser(user_id) {
    return (await pool.query('SELECT * FROM savings_goals WHERE user_id=$1 ORDER BY created_at', [user_id])).rows;
  },
  async getSavingsGoalById(id) {
    return (await pool.query('SELECT * FROM savings_goals WHERE id=$1', [id])).rows[0];
  },
  async getSavingsGoalByIdAndUser(id, user_id) {
    return (await pool.query('SELECT * FROM savings_goals WHERE id=$1 AND user_id=$2', [id, user_id])).rows[0];
  },
  async addSavingsGoal(user_id, name, icon, target_amount, current_amount) {
    return (await pool.query(
      'INSERT INTO savings_goals (user_id, name, icon, target_amount, current_amount) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [user_id, name, icon, target_amount, current_amount]
    )).rows[0];
  },
  async updateSavingsGoal(current_amount, name, icon, target_amount, id, user_id) {
    await pool.query(
      'UPDATE savings_goals SET current_amount=$1, name=$2, icon=$3, target_amount=$4 WHERE id=$5 AND user_id=$6',
      [current_amount, name, icon, target_amount, id, user_id]
    );
  },
  async updateSavingsGoalAdmin(name, icon, target_amount, current_amount, id) {
    await pool.query(
      'UPDATE savings_goals SET name=$1, icon=$2, target_amount=$3, current_amount=$4 WHERE id=$5',
      [name, icon, target_amount, current_amount, id]
    );
  },
  async deleteSavingsGoal(id, user_id) {
    return (await pool.query('DELETE FROM savings_goals WHERE id=$1 AND user_id=$2', [id, user_id])).rowCount;
  },
  async deleteSavingsAdmin(id) {
    return (await pool.query('DELETE FROM savings_goals WHERE id=$1', [id])).rowCount;
  },

  // Onboarding leads
  async createLead(data) {
    return (await pool.query(
      `INSERT INTO onboarding_leads
        (first_name,last_name,age,nationality,email,phone,club,position,league,
         weekly_wage,contract_end,contract_type,extra_income,has_advisor,
         spending_style,spending_categories,monthly_savings,goals,concerns,priority_text,heard_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [data.first_name,data.last_name,data.age,data.nationality,data.email,data.phone,
       data.club,data.position,data.league,data.weekly_wage,data.contract_end,data.contract_type,
       data.extra_income,data.has_advisor,data.spending_style,data.spending_categories,
       data.monthly_savings,data.goals,data.concerns,data.priority_text,data.heard_via]
    )).rows[0];
  },
  async getAllLeads() {
    return (await pool.query(
      'SELECT * FROM onboarding_leads ORDER BY created_at DESC'
    )).rows;
  },
  async updateLeadStatus(id, status) {
    await pool.query('UPDATE onboarding_leads SET status=$1 WHERE id=$2', [status, id]);
  },
  async deleteLead(id) {
    return (await pool.query('DELETE FROM onboarding_leads WHERE id=$1', [id])).rowCount;
  },

  // Income records
  async getIncomeByUser(user_id) {
    return (await pool.query('SELECT * FROM income_records WHERE user_id=$1 ORDER BY year DESC, month DESC', [user_id])).rows;
  },
  async upsertIncome(user_id, month, year, gross_monthly, net_monthly, agent_fee_pct, notes) {
    await pool.query(
      `INSERT INTO income_records (user_id, month, year, gross_monthly, net_monthly, agent_fee_pct, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, month, year) DO UPDATE SET gross_monthly=$4, net_monthly=$5, agent_fee_pct=$6, notes=$7`,
      [user_id, month, year, gross_monthly, net_monthly, agent_fee_pct, notes]
    );
  },
};

// ─── SUMMARY HELPER ──────────────────────────────────────────────────────────

async function getSummary(userId) {
  const user = await q.getUserById(userId);
  if (!user) return null;

  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() + diff);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

  const wStart = weekStart.toISOString().split('T')[0];
  const wEnd = weekEnd.toISOString().split('T')[0];
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const [weekCatsRes, budgets, savings, recentRes, monthCatsRes] = await Promise.all([
    pool.query(
      'SELECT category, SUM(amount) as total FROM expenses WHERE user_id=$1 AND date>=$2 AND date<=$3 GROUP BY category',
      [userId, wStart, wEnd]
    ),
    q.getBudgetsByUser(userId),
    q.getSavingsByUser(userId),
    pool.query('SELECT * FROM expenses WHERE user_id=$1 ORDER BY date DESC, created_at DESC LIMIT 5', [userId]),
    pool.query(
      'SELECT category, SUM(amount) as total FROM expenses WHERE user_id=$1 AND date>=$2 GROUP BY category',
      [userId, monthStart]
    ),
  ]);

  const weekCats = weekCatsRes.rows;
  const recentExpenses = recentRes.rows;
  const monthCats = monthCatsRes.rows;

  const CATEGORIES = ['Housing', 'Food', 'Transport', 'Clothing', 'Entertainment', 'Family', 'Savings', 'Other'];
  const budgetMap = {};
  budgets.forEach(b => { budgetMap[b.category] = b.monthly_limit; });
  const spentMapWeek = {};
  weekCats.forEach(c => { spentMapWeek[c.category] = parseFloat(c.total); });
  const spentMapMonth = {};
  monthCats.forEach(c => { spentMapMonth[c.category] = parseFloat(c.total); });

  const monthlyWageNet = user.monthly_wage_net;
  const weeklyWageNet = Math.round(monthlyWageNet * 12 / 52 * 100) / 100;

  const spendingByCategory = CATEGORIES.map(cat => ({
    category: cat,
    monthlyLimit: budgetMap[cat] || 0,
    weeklyLimit: Math.round((budgetMap[cat] || 0) * 12 / 52 * 100) / 100,
    weeklySpent: spentMapWeek[cat] || 0,
    monthlySpent: spentMapMonth[cat] || 0,
  }));

  const totalSpentThisWeek = weekCats.reduce((s, c) => s + parseFloat(c.total), 0);
  const totalMonthlyBudget = budgets.reduce((s, b) => s + b.monthly_limit, 0);
  const totalWeeklyBudget = Math.round(totalMonthlyBudget * 12 / 52 * 100) / 100;

  return {
    player: {
      id: user.id, name: user.name, club: user.club,
      position: user.position, monthlyWageNet, weeklyWageNet, born: user.born,
    },
    monthlyWageNet,
    weeklyWageNet,
    totalSpentThisWeek,
    totalBudget: totalWeeklyBudget,
    remainingBudget: weeklyWageNet - totalSpentThisWeek,
    spendingByCategory,
    savings,
    recentExpenses,
    weekRange: { start: wStart, end: wEnd },
  };
}

// ─── SEED ─────────────────────────────────────────────────────────────────────

async function seedAdminIfEmpty() {
  const res = await pool.query('SELECT COUNT(*) as c FROM users');
  if (parseInt(res.rows[0].c) === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@flairfinancials.co.uk';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = bcrypt.hashSync(password, 12);
    await pool.query(
      "INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'admin', 'Admin')",
      [email, hash]
    );
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  FLAIR FINANCIALS — First-run setup      ║');
    console.log('║  Admin account created:                  ║');
    console.log(`║  Email:    ${email.padEnd(31)}║`);
    console.log(`║  Password: ${password.padEnd(31)}║`);
    console.log('║  Change this password after first login! ║');
    console.log('╚══════════════════════════════════════════╝\n');
  }
}

// ─── SEED DEFAULT PLAYERS ─────────────────────────────────────────────────────

async function seedDefaultPlayers() {
  const REECE_MONTHLY = 27500;
  const reece = await q.getUserByEmail('reece@flairfinancials.com');
  if (!reece) {
    const hash = bcrypt.hashSync('Welch2024', 12);
    await q.createUser('reece@flairfinancials.com', hash, 'player', 'Reece Welch', 'Everton', 'Defender', REECE_MONTHLY, null);
    console.log('Seeded player: Reece Welch (reece@flairfinancials.com / Welch2024)');
  } else if (reece.monthly_wage_net === 0) {
    await q.updateUser(reece.name, reece.email, reece.club, reece.position, REECE_MONTHLY, reece.born, reece.id);
    console.log('Updated Reece Welch monthly income to £27,500');
  }
}

// ─── SESSION STORE ────────────────────────────────────────────────────────────

function buildSessionStore(session) {
  const pgSession = require('connect-pg-simple')(session);
  return new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  });
}

module.exports = { pool, q, getSummary, initSchema, seedAdminIfEmpty, seedDefaultPlayers, buildSessionStore };
