require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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
      weekly_wage_net  REAL    DEFAULT 0,
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
      weekly_limit REAL    NOT NULL DEFAULT 0,
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
      gross_weekly  REAL    DEFAULT 0,
      net_weekly    REAL    DEFAULT 0,
      agent_fee_pct REAL    DEFAULT 0,
      notes         TEXT    DEFAULT '',
      UNIQUE(user_id, month, year)
    );
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
      "SELECT id, email, name, club, position, weekly_wage_net, born, created_at FROM users WHERE role='player' ORDER BY name"
    )).rows;
  },
  async createUser(email, password_hash, role, name, club, position, weekly_wage_net, born) {
    return (await pool.query(
      'INSERT INTO users (email, password_hash, role, name, club, position, weekly_wage_net, born) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [email, password_hash, role, name, club, position, weekly_wage_net, born]
    )).rows[0];
  },
  async updateUser(name, email, club, position, weekly_wage_net, born, id) {
    await pool.query(
      'UPDATE users SET name=$1, email=$2, club=$3, position=$4, weekly_wage_net=$5, born=$6 WHERE id=$7',
      [name, email, club, position, weekly_wage_net, born, id]
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
  async upsertBudget(user_id, category, weekly_limit) {
    await pool.query(
      'INSERT INTO budgets (user_id, category, weekly_limit) VALUES ($1,$2,$3) ON CONFLICT (user_id, category) DO UPDATE SET weekly_limit=$3',
      [user_id, category, weekly_limit]
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

  // Income records
  async getIncomeByUser(user_id) {
    return (await pool.query('SELECT * FROM income_records WHERE user_id=$1 ORDER BY year DESC, month DESC', [user_id])).rows;
  },
  async upsertIncome(user_id, month, year, gross_weekly, net_weekly, agent_fee_pct, notes) {
    await pool.query(
      `INSERT INTO income_records (user_id, month, year, gross_weekly, net_weekly, agent_fee_pct, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, month, year) DO UPDATE SET gross_weekly=$4, net_weekly=$5, agent_fee_pct=$6, notes=$7`,
      [user_id, month, year, gross_weekly, net_weekly, agent_fee_pct, notes]
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
  budgets.forEach(b => { budgetMap[b.category] = b.weekly_limit; });
  const spentMapWeek = {};
  weekCats.forEach(c => { spentMapWeek[c.category] = parseFloat(c.total); });
  const spentMapMonth = {};
  monthCats.forEach(c => { spentMapMonth[c.category] = parseFloat(c.total); });

  const spendingByCategory = CATEGORIES.map(cat => ({
    category: cat,
    weeklyLimit: budgetMap[cat] || 0,
    weeklySpent: spentMapWeek[cat] || 0,
    monthlySpent: spentMapMonth[cat] || 0,
  }));

  const totalSpentThisWeek = weekCats.reduce((s, c) => s + parseFloat(c.total), 0);
  const totalBudget = budgets.reduce((s, b) => s + b.weekly_limit, 0);

  return {
    player: {
      id: user.id, name: user.name, club: user.club,
      position: user.position, weeklyWageNet: user.weekly_wage_net, born: user.born,
    },
    weeklyWageNet: user.weekly_wage_net,
    totalSpentThisWeek,
    totalBudget,
    remainingBudget: user.weekly_wage_net - totalSpentThisWeek,
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

// ─── SESSION STORE ────────────────────────────────────────────────────────────

function buildSessionStore(session) {
  const pgSession = require('connect-pg-simple')(session);
  return new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  });
}

module.exports = { pool, q, getSummary, initSchema, seedAdminIfEmpty, buildSessionStore };
