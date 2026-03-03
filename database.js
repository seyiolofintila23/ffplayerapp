require('dotenv').config();
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// On Render.com the persistent disk is mounted at /opt/render/project/src/data
// Locally it uses the data/ folder next to server.js
const DATA_DIR = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, 'data')
  : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'flair.db'));

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    email            TEXT    NOT NULL UNIQUE,
    password_hash    TEXT    NOT NULL,
    role             TEXT    NOT NULL DEFAULT 'player',
    name             TEXT    NOT NULL,
    club             TEXT,
    position         TEXT,
    weekly_wage_net  REAL    DEFAULT 0,
    born             TEXT,
    created_at       TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date            TEXT    NOT NULL,
    description     TEXT    NOT NULL,
    amount          REAL    NOT NULL,
    category        TEXT    NOT NULL,
    payment_method  TEXT    DEFAULT 'Card',
    notes           TEXT    DEFAULT '',
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category     TEXT    NOT NULL,
    weekly_limit REAL    NOT NULL DEFAULT 0,
    UNIQUE(user_id, category)
  );

  CREATE TABLE IF NOT EXISTS savings_goals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT    NOT NULL,
    icon           TEXT    DEFAULT '🎯',
    target_amount  REAL    NOT NULL DEFAULT 0,
    current_amount REAL    NOT NULL DEFAULT 0,
    created_at     TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS income_records (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month         INTEGER NOT NULL,
    year          INTEGER NOT NULL,
    gross_weekly  REAL    DEFAULT 0,
    net_weekly    REAL    DEFAULT 0,
    agent_fee_pct REAL    DEFAULT 0,
    notes         TEXT    DEFAULT '',
    UNIQUE(user_id, month, year)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT    PRIMARY KEY,
    sess       TEXT    NOT NULL,
    expired_at INTEGER NOT NULL
  );
`);

// ─── PREPARED STATEMENTS ──────────────────────────────────────────────────────

const stmts = {
  // Users
  getUserByEmail:  db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById:     db.prepare('SELECT * FROM users WHERE id = ?'),
  getAllPlayers:   db.prepare("SELECT id, email, name, club, position, weekly_wage_net, born, created_at FROM users WHERE role = 'player' ORDER BY name"),
  createUser:      db.prepare('INSERT INTO users (email, password_hash, role, name, club, position, weekly_wage_net, born) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updateUser:      db.prepare('UPDATE users SET name=?, email=?, club=?, position=?, weekly_wage_net=?, born=? WHERE id=?'),
  updatePassword:  db.prepare('UPDATE users SET password_hash=? WHERE id=?'),
  deleteUser:      db.prepare('DELETE FROM users WHERE id=?'),

  // Expenses
  getExpensesByUser:    db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC, created_at DESC'),
  getExpensesByUserAdmin: db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC'),
  addExpense:           db.prepare('INSERT INTO expenses (user_id, date, description, amount, category, payment_method, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  deleteExpenseOwn:     db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?'),
  deleteExpenseAdmin:   db.prepare('DELETE FROM expenses WHERE id = ?'),
  getExpenseById:       db.prepare('SELECT * FROM expenses WHERE id = ?'),

  // Budgets
  getBudgetsByUser:  db.prepare('SELECT * FROM budgets WHERE user_id = ?'),
  upsertBudget:      db.prepare('INSERT OR REPLACE INTO budgets (user_id, category, weekly_limit) VALUES (?, ?, ?)'),
  deleteBudgetsByUser: db.prepare('DELETE FROM budgets WHERE user_id = ?'),

  // Savings goals
  getSavingsByUser:  db.prepare('SELECT * FROM savings_goals WHERE user_id = ? ORDER BY created_at'),
  addSavingsGoal:    db.prepare('INSERT INTO savings_goals (user_id, name, icon, target_amount, current_amount) VALUES (?, ?, ?, ?, ?)'),
  updateSavingsGoal: db.prepare('UPDATE savings_goals SET current_amount=?, name=?, icon=?, target_amount=? WHERE id=? AND user_id=?'),
  deleteSavingsGoal: db.prepare('DELETE FROM savings_goals WHERE id=? AND user_id=?'),
  deleteSavingsAdmin: db.prepare('DELETE FROM savings_goals WHERE id=?'),

  // Income records
  getIncomByUser:  db.prepare('SELECT * FROM income_records WHERE user_id = ? ORDER BY year DESC, month DESC'),
  upsertIncome:    db.prepare('INSERT OR REPLACE INTO income_records (user_id, month, year, gross_weekly, net_weekly, agent_fee_pct, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'),
};

// ─── SUMMARY HELPER ──────────────────────────────────────────────────────────

function getSummary(userId) {
  return db.transaction(() => {
    const user = stmts.getUserById.get(userId);
    if (!user) return null;

    // Current ISO week (Mon–Sun)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun
    const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() + diff);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const wStart = weekStart.toISOString().split('T')[0];
    const wEnd = weekEnd.toISOString().split('T')[0];

    // This week's spending grouped by category
    const weekCats = db.prepare(
      `SELECT category, SUM(amount) as total
       FROM expenses WHERE user_id=? AND date>=? AND date<=?
       GROUP BY category`
    ).all(userId, wStart, wEnd);

    const budgets = stmts.getBudgetsByUser.all(userId);
    const savings = stmts.getSavingsByUser.all(userId);
    const recentExpenses = db.prepare(
      'SELECT * FROM expenses WHERE user_id=? ORDER BY date DESC, created_at DESC LIMIT 5'
    ).all(userId);

    // This month's expenses for the spending tab
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthCats = db.prepare(
      `SELECT category, SUM(amount) as total
       FROM expenses WHERE user_id=? AND date>=?
       GROUP BY category`
    ).all(userId, monthStart);

    // Build spending by category (merging budgets + actuals)
    const CATEGORIES = ['Housing', 'Food', 'Transport', 'Clothing', 'Entertainment', 'Family', 'Savings', 'Other'];
    const budgetMap = {};
    budgets.forEach(b => { budgetMap[b.category] = b.weekly_limit; });
    const spentMapWeek = {};
    weekCats.forEach(c => { spentMapWeek[c.category] = c.total; });
    const spentMapMonth = {};
    monthCats.forEach(c => { spentMapMonth[c.category] = c.total; });

    const spendingByCategory = CATEGORIES.map(cat => ({
      category: cat,
      weeklyLimit: budgetMap[cat] || 0,
      weeklySpent: spentMapWeek[cat] || 0,
      monthlySpent: spentMapMonth[cat] || 0,
    }));

    const totalSpentThisWeek = weekCats.reduce((s, c) => s + c.total, 0);
    const totalBudget = budgets.reduce((s, b) => s + b.weekly_limit, 0);

    return {
      player: {
        id: user.id,
        name: user.name,
        club: user.club,
        position: user.position,
        weeklyWageNet: user.weekly_wage_net,
        born: user.born,
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
  })();
}

// ─── SEED ─────────────────────────────────────────────────────────────────────

function seedAdminIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@flairfinancials.co.uk';
    const password = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = bcrypt.hashSync(password, 12);
    db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?, ?, 'admin', 'Admin')")
      .run(email, hash);
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  FLAIR FINANCIALS — First-run setup      ║');
    console.log('║  Admin account created:                  ║');
    console.log(`║  Email:    ${email.padEnd(31)}║`);
    console.log(`║  Password: ${password.padEnd(31)}║`);
    console.log('║  Change this password after first login! ║');
    console.log('╚══════════════════════════════════════════╝\n');
  }
}

// ─── SESSION STORE (pure better-sqlite3, no extra packages) ───────────────────

function buildSessionStore(session) {
  const Store = session.Store;
  class SQLiteSessionStore extends Store {
    constructor() {
      super();
      // Clean up expired sessions every 10 minutes
      setInterval(() => {
        db.prepare('DELETE FROM sessions WHERE expired_at < ?').run(Date.now());
      }, 10 * 60 * 1000);
    }
    get(sid, cb) {
      try {
        const row = db.prepare('SELECT sess, expired_at FROM sessions WHERE sid = ?').get(sid);
        if (!row || row.expired_at < Date.now()) return cb(null, null);
        cb(null, JSON.parse(row.sess));
      } catch (e) { cb(e); }
    }
    set(sid, sess, cb) {
      try {
        const maxAge = sess.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000;
        const expiredAt = Date.now() + maxAge;
        db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)')
          .run(sid, JSON.stringify(sess), expiredAt);
        cb(null);
      } catch (e) { cb(e); }
    }
    destroy(sid, cb) {
      try {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        cb(null);
      } catch (e) { cb(e); }
    }
  }
  return new SQLiteSessionStore();
}

module.exports = { db, stmts, getSummary, seedAdminIfEmpty, buildSessionStore };
