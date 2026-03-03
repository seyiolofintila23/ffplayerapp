require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const SQLiteStore = require('connect-sqlite3')(session);
const { db, stmts, getSummary, seedAdminIfEmpty } = require('./database');
const { requireAuth, requireAdmin, attachUser } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;

const VALID_CATEGORIES = ['Housing', 'Food', 'Transport', 'Clothing', 'Entertainment', 'Family', 'Savings', 'Other'];
const VALID_METHODS = ['Card', 'Cash', 'Bank Transfer', 'Direct Debit'];

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'flair.db', dir: './data' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-please-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));

app.use(attachUser);

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = stmts.getUserByEmail.get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.id;
  req.session.role = user.role;

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    club: user.club,
    position: user.position,
    weeklyWageNet: user.weekly_wage_net,
    born: user.born,
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = stmts.getUserById.get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    club: user.club,
    position: user.position,
    weeklyWageNet: user.weekly_wage_net,
    born: user.born,
  });
});

// ─── PLAYER ROUTES ────────────────────────────────────────────────────────────

// Summary (overview tab data — single transaction)
app.get('/api/summary', requireAuth, (req, res) => {
  const summary = getSummary(req.user.id);
  if (!summary) return res.status(404).json({ error: 'Player not found' });
  res.json(summary);
});

// Expenses
app.get('/api/expenses', requireAuth, (req, res) => {
  res.json(stmts.getExpensesByUser.all(req.user.id));
});

app.post('/api/expenses', requireAuth, (req, res) => {
  const { date, description, amount, category, payment_method, notes } = req.body;

  if (!date || !description || amount === undefined || !category) {
    return res.status(400).json({ error: 'date, description, amount, and category are required' });
  }
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
  if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (payment_method && !VALID_METHODS.includes(payment_method)) return res.status(400).json({ error: 'Invalid payment method' });

  const result = stmts.addExpense.run(req.user.id, date, description.trim(), amt, category, payment_method || 'Card', notes || '');
  const expense = db.prepare('SELECT * FROM expenses WHERE id=?').get(result.lastInsertRowid);
  res.status(201).json(expense);
});

app.delete('/api/expenses/:id', requireAuth, (req, res) => {
  const result = stmts.deleteExpenseOwn.run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Expense not found' });
  res.json({ ok: true });
});

// Budget
app.get('/api/budget', requireAuth, (req, res) => {
  res.json(stmts.getBudgetsByUser.all(req.user.id));
});

// Savings goals
app.get('/api/savings', requireAuth, (req, res) => {
  res.json(stmts.getSavingsByUser.all(req.user.id));
});

app.post('/api/savings', requireAuth, (req, res) => {
  const { name, icon, target_amount, current_amount } = req.body;
  if (!name || target_amount === undefined) return res.status(400).json({ error: 'name and target_amount required' });
  const target = parseFloat(target_amount);
  const current = parseFloat(current_amount) || 0;
  if (isNaN(target) || target <= 0) return res.status(400).json({ error: 'Invalid target amount' });

  const result = stmts.addSavingsGoal.run(req.user.id, name.trim(), icon || '🎯', target, current);
  const goal = db.prepare('SELECT * FROM savings_goals WHERE id=?').get(result.lastInsertRowid);
  res.status(201).json(goal);
});

app.put('/api/savings/:id', requireAuth, (req, res) => {
  const { name, icon, target_amount, current_amount } = req.body;
  const goal = db.prepare('SELECT * FROM savings_goals WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });

  stmts.updateSavingsGoal.run(
    parseFloat(current_amount) ?? goal.current_amount,
    name || goal.name,
    icon || goal.icon,
    parseFloat(target_amount) ?? goal.target_amount,
    req.params.id,
    req.user.id
  );
  res.json(db.prepare('SELECT * FROM savings_goals WHERE id=?').get(req.params.id));
});

app.delete('/api/savings/:id', requireAuth, (req, res) => {
  const result = stmts.deleteSavingsGoal.run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Goal not found' });
  res.json({ ok: true });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

// List all players
app.get('/api/admin/players', requireAuth, requireAdmin, (req, res) => {
  const players = stmts.getAllPlayers.all();
  // Attach basic stats to each player
  const result = players.map(p => {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthSpend = db.prepare(
      'SELECT SUM(amount) as total FROM expenses WHERE user_id=? AND date>=?'
    ).get(p.id, monthStart);
    const goalCount = db.prepare('SELECT COUNT(*) as c FROM savings_goals WHERE user_id=?').get(p.id);
    return { ...p, monthlySpend: monthSpend.total || 0, goalCount: goalCount.c };
  });
  res.json(result);
});

// Create player
app.post('/api/admin/players', requireAuth, requireAdmin, (req, res) => {
  const { email, password, name, club, position, weekly_wage_net, born } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, and name required' });

  const existing = stmts.getUserByEmail.get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'Email already in use' });

  const hash = bcrypt.hashSync(password, 12);
  const result = stmts.createUser.run(
    email.toLowerCase().trim(), hash, 'player', name.trim(),
    club || null, position || null, parseFloat(weekly_wage_net) || 0, born || null
  );
  const user = stmts.getUserById.get(result.lastInsertRowid);

  // Set default budgets if provided
  if (req.body.budgets && Array.isArray(req.body.budgets)) {
    const setBudgets = db.transaction((budgets) => {
      budgets.forEach(b => {
        if (VALID_CATEGORIES.includes(b.category) && b.weekly_limit >= 0) {
          stmts.upsertBudget.run(user.id, b.category, parseFloat(b.weekly_limit));
        }
      });
    });
    setBudgets(req.body.budgets);
  }

  res.status(201).json({ id: user.id, name: user.name, email: user.email });
});

// Get single player (admin view)
app.get('/api/admin/players/:id', requireAuth, requireAdmin, (req, res) => {
  const user = stmts.getUserById.get(req.params.id);
  if (!user || user.role === 'admin') return res.status(404).json({ error: 'Player not found' });

  const budgets = stmts.getBudgetsByUser.all(user.id);
  const savings = stmts.getSavingsByUser.all(user.id);
  const income = stmts.getIncomByUser.all(user.id);
  const expenses = stmts.getExpensesByUserAdmin.all(user.id);

  res.json({
    id: user.id, name: user.name, email: user.email, club: user.club,
    position: user.position, weeklyWageNet: user.weekly_wage_net,
    born: user.born, createdAt: user.created_at,
    budgets, savings, income, expenses
  });
});

// Update player profile
app.put('/api/admin/players/:id', requireAuth, requireAdmin, (req, res) => {
  const user = stmts.getUserById.get(req.params.id);
  if (!user || user.role === 'admin') return res.status(404).json({ error: 'Player not found' });

  const { name, email, club, position, weekly_wage_net, born } = req.body;

  if (email && email !== user.email) {
    const existing = stmts.getUserByEmail.get(email.toLowerCase().trim());
    if (existing && existing.id !== user.id) return res.status(409).json({ error: 'Email already in use' });
  }

  stmts.updateUser.run(
    name || user.name,
    (email || user.email).toLowerCase().trim(),
    club !== undefined ? club : user.club,
    position !== undefined ? position : user.position,
    weekly_wage_net !== undefined ? parseFloat(weekly_wage_net) : user.weekly_wage_net,
    born !== undefined ? born : user.born,
    req.params.id
  );
  res.json({ ok: true });
});

// Delete player
app.delete('/api/admin/players/:id', requireAuth, requireAdmin, (req, res) => {
  const user = stmts.getUserById.get(req.params.id);
  if (!user || user.role === 'admin') return res.status(404).json({ error: 'Player not found' });
  stmts.deleteUser.run(req.params.id);
  res.json({ ok: true });
});

// Set player budgets (replace all)
app.put('/api/admin/players/:id/budget', requireAuth, requireAdmin, (req, res) => {
  const user = stmts.getUserById.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Player not found' });

  const { budgets } = req.body;
  if (!Array.isArray(budgets)) return res.status(400).json({ error: 'budgets array required' });

  db.transaction(() => {
    stmts.deleteBudgetsByUser.run(req.params.id);
    budgets.forEach(b => {
      if (VALID_CATEGORIES.includes(b.category)) {
        stmts.upsertBudget.run(req.params.id, b.category, parseFloat(b.weekly_limit) || 0);
      }
    });
  })();

  res.json({ ok: true });
});

// Upsert income record
app.post('/api/admin/players/:id/income', requireAuth, requireAdmin, (req, res) => {
  const user = stmts.getUserById.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Player not found' });

  const { month, year, gross_weekly, net_weekly, agent_fee_pct, notes } = req.body;
  if (!month || !year) return res.status(400).json({ error: 'month and year required' });

  stmts.upsertIncome.run(
    req.params.id, parseInt(month), parseInt(year),
    parseFloat(gross_weekly) || 0, parseFloat(net_weekly) || 0,
    parseFloat(agent_fee_pct) || 0, notes || ''
  );
  res.json({ ok: true });
});

// Get player expenses (admin)
app.get('/api/admin/players/:id/expenses', requireAuth, requireAdmin, (req, res) => {
  res.json(stmts.getExpensesByUserAdmin.all(req.params.id));
});

// Add expense for player (admin)
app.post('/api/admin/players/:id/expenses', requireAuth, requireAdmin, (req, res) => {
  const { date, description, amount, category, payment_method, notes } = req.body;
  if (!date || !description || amount === undefined || !category) {
    return res.status(400).json({ error: 'date, description, amount, and category required' });
  }
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });

  const result = stmts.addExpense.run(req.params.id, date, description.trim(), amt, category, payment_method || 'Card', notes || '');
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id=?').get(result.lastInsertRowid));
});

// Delete any expense (admin)
app.delete('/api/admin/expenses/:id', requireAuth, requireAdmin, (req, res) => {
  const result = stmts.deleteExpenseAdmin.run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Expense not found' });
  res.json({ ok: true });
});

// Admin: manage player savings goals
app.post('/api/admin/players/:id/savings', requireAuth, requireAdmin, (req, res) => {
  const { name, icon, target_amount, current_amount } = req.body;
  if (!name || !target_amount) return res.status(400).json({ error: 'name and target_amount required' });
  const result = stmts.addSavingsGoal.run(
    req.params.id, name.trim(), icon || '🎯',
    parseFloat(target_amount), parseFloat(current_amount) || 0
  );
  res.status(201).json(db.prepare('SELECT * FROM savings_goals WHERE id=?').get(result.lastInsertRowid));
});

app.put('/api/admin/savings/:id', requireAuth, requireAdmin, (req, res) => {
  const goal = db.prepare('SELECT * FROM savings_goals WHERE id=?').get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  const { name, icon, target_amount, current_amount } = req.body;
  db.prepare('UPDATE savings_goals SET name=?, icon=?, target_amount=?, current_amount=? WHERE id=?').run(
    name || goal.name, icon || goal.icon,
    parseFloat(target_amount) ?? goal.target_amount,
    parseFloat(current_amount) ?? goal.current_amount,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/admin/savings/:id', requireAuth, requireAdmin, (req, res) => {
  const result = stmts.deleteSavingsAdmin.run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Goal not found' });
  res.json({ ok: true });
});

// Reset player password
app.post('/api/admin/players/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = bcrypt.hashSync(newPassword, 12);
  stmts.updatePassword.run(hash, req.params.id);
  res.json({ ok: true });
});

// Admin overview stats
app.get('/api/admin/overview', requireAuth, requireAdmin, (req, res) => {
  const players = stmts.getAllPlayers.all();
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const totalMonthlySpend = db.prepare(
    "SELECT SUM(amount) as total FROM expenses WHERE date>=?"
  ).get(monthStart);

  const totalSavingsTarget = db.prepare(
    'SELECT SUM(target_amount) as total FROM savings_goals'
  ).get();

  const totalSavingsCurrent = db.prepare(
    'SELECT SUM(current_amount) as total FROM savings_goals'
  ).get();

  res.json({
    playerCount: players.length,
    totalMonthlySpend: totalMonthlySpend.total || 0,
    totalSavingsTarget: totalSavingsTarget.total || 0,
    totalSavingsCurrent: totalSavingsCurrent.total || 0,
  });
});

// ─── ADMIN PANEL ROUTE ───────────────────────────────────────────────────────

// Admin panel served at /ffadmin only — not publicly browsable
app.get('/ffadmin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Redirect old /admin.html path to /ffadmin
app.get('/admin.html', (req, res) => {
  res.redirect(301, '/ffadmin');
});

// ─── CATCH-ALL ────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

seedAdminIfEmpty();
app.listen(PORT, () => {
  console.log(`⚽ FFplayerapp running → http://localhost:${PORT}`);
  console.log(`   Advisor panel → http://localhost:${PORT}/ffadmin`);
});
