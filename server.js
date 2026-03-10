require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const { pool, q, getSummary, initSchema, seedAdminIfEmpty, seedDefaultPlayers, buildSessionStore } = require('./database');
const { requireAuth, requireAdmin, attachUser } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;

const VALID_CATEGORIES = ['Housing', 'Food', 'Transport', 'Clothing', 'Entertainment', 'Family', 'Savings', 'Other'];
const VALID_METHODS = ['Card', 'Cash', 'Bank Transfer', 'Direct Debit'];

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: buildSessionStore(session),
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await q.getUserByEmail(email.toLowerCase().trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.role = user.role;

    res.json({
      id: user.id, name: user.name, email: user.email, role: user.role,
      club: user.club, position: user.position, weeklyWageNet: user.weekly_wage_net, born: user.born,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await q.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id, name: user.name, email: user.email, role: user.role,
      club: user.club, position: user.position, weeklyWageNet: user.weekly_wage_net, born: user.born,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ─── PLAYER ROUTES ────────────────────────────────────────────────────────────

app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const summary = await getSummary(req.user.id);
    if (!summary) return res.status(404).json({ error: 'Player not found' });
    res.json(summary);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    res.json(await q.getExpensesByUser(req.user.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { date, description, amount, category, payment_method, notes } = req.body;
    if (!date || !description || amount === undefined || !category) {
      return res.status(400).json({ error: 'date, description, amount, and category are required' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
    if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
    if (payment_method && !VALID_METHODS.includes(payment_method)) return res.status(400).json({ error: 'Invalid payment method' });

    const expense = await q.addExpense(req.user.id, date, description.trim(), amt, category, payment_method || 'Card', notes || '');
    res.status(201).json(expense);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  try {
    const count = await q.deleteExpenseOwn(req.params.id, req.user.id);
    if (count === 0) return res.status(404).json({ error: 'Expense not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/budget', requireAuth, async (req, res) => {
  try {
    res.json(await q.getBudgetsByUser(req.user.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/savings', requireAuth, async (req, res) => {
  try {
    res.json(await q.getSavingsByUser(req.user.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/savings', requireAuth, async (req, res) => {
  try {
    const { name, icon, target_amount, current_amount } = req.body;
    if (!name || target_amount === undefined) return res.status(400).json({ error: 'name and target_amount required' });
    const target = parseFloat(target_amount);
    const current = parseFloat(current_amount) || 0;
    if (isNaN(target) || target <= 0) return res.status(400).json({ error: 'Invalid target amount' });

    const goal = await q.addSavingsGoal(req.user.id, name.trim(), icon || '🎯', target, current);
    res.status(201).json(goal);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/savings/:id', requireAuth, async (req, res) => {
  try {
    const { name, icon, target_amount, current_amount } = req.body;
    const goal = await q.getSavingsGoalByIdAndUser(req.params.id, req.user.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    await q.updateSavingsGoal(
      parseFloat(current_amount) ?? goal.current_amount,
      name || goal.name,
      icon || goal.icon,
      parseFloat(target_amount) ?? goal.target_amount,
      req.params.id,
      req.user.id
    );
    res.json(await q.getSavingsGoalById(req.params.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/savings/:id', requireAuth, async (req, res) => {
  try {
    const count = await q.deleteSavingsGoal(req.params.id, req.user.id);
    if (count === 0) return res.status(404).json({ error: 'Goal not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

// Create advisor account
app.post('/api/admin/advisors', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password, and name required' });

    const existing = await q.getUserByEmail(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const hash = bcrypt.hashSync(password, 12);
    const user = await q.createUser(email.toLowerCase().trim(), hash, 'admin', name.trim(), null, null, 0, null);
    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// List all players
app.get('/api/admin/players', requireAuth, requireAdmin, async (req, res) => {
  try {
    const players = await q.getAllPlayers();
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const result = await Promise.all(players.map(async p => {
      const [spendRes, goalRes] = await Promise.all([
        pool.query('SELECT SUM(amount) as total FROM expenses WHERE user_id=$1 AND date>=$2', [p.id, monthStart]),
        pool.query('SELECT COUNT(*) as c FROM savings_goals WHERE user_id=$1', [p.id]),
      ]);
      return { ...p, monthlySpend: parseFloat(spendRes.rows[0].total) || 0, goalCount: parseInt(goalRes.rows[0].c) };
    }));
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Create player
app.post('/api/admin/players', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, password, name, club, position, weekly_wage_net, born } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password, and name required' });

    const existing = await q.getUserByEmail(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const hash = bcrypt.hashSync(password, 12);
    const user = await q.createUser(
      email.toLowerCase().trim(), hash, 'player', name.trim(),
      club || null, position || null, parseFloat(weekly_wage_net) || 0, born || null
    );

    if (req.body.budgets && Array.isArray(req.body.budgets)) {
      await Promise.all(req.body.budgets
        .filter(b => VALID_CATEGORIES.includes(b.category) && b.weekly_limit >= 0)
        .map(b => q.upsertBudget(user.id, b.category, parseFloat(b.weekly_limit)))
      );
    }

    res.status(201).json({ id: user.id, name: user.name, email: user.email });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Get single player (admin view)
app.get('/api/admin/players/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await q.getUserById(req.params.id);
    if (!user || user.role === 'admin') return res.status(404).json({ error: 'Player not found' });

    const [budgets, savings, income, expenses] = await Promise.all([
      q.getBudgetsByUser(user.id),
      q.getSavingsByUser(user.id),
      q.getIncomeByUser(user.id),
      q.getExpensesByUserAdmin(user.id),
    ]);

    res.json({
      id: user.id, name: user.name, email: user.email, club: user.club,
      position: user.position, weeklyWageNet: user.weekly_wage_net,
      born: user.born, createdAt: user.created_at,
      budgets, savings, income, expenses,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Update player profile
app.put('/api/admin/players/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await q.getUserById(req.params.id);
    if (!user || user.role === 'admin') return res.status(404).json({ error: 'Player not found' });

    const { name, email, club, position, weekly_wage_net, born } = req.body;

    if (email && email !== user.email) {
      const existing = await q.getUserByEmail(email.toLowerCase().trim());
      if (existing && existing.id !== user.id) return res.status(409).json({ error: 'Email already in use' });
    }

    await q.updateUser(
      name || user.name,
      (email || user.email).toLowerCase().trim(),
      club !== undefined ? club : user.club,
      position !== undefined ? position : user.position,
      weekly_wage_net !== undefined ? parseFloat(weekly_wage_net) : user.weekly_wage_net,
      born !== undefined ? born : user.born,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Delete player
app.delete('/api/admin/players/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await q.getUserById(req.params.id);
    if (!user || user.role === 'admin') return res.status(404).json({ error: 'Player not found' });
    await q.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Set player budgets (replace all)
app.put('/api/admin/players/:id/budget', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await q.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Player not found' });

    const { budgets } = req.body;
    if (!Array.isArray(budgets)) return res.status(400).json({ error: 'budgets array required' });

    await q.deleteBudgetsByUser(req.params.id);
    await Promise.all(budgets
      .filter(b => VALID_CATEGORIES.includes(b.category))
      .map(b => q.upsertBudget(req.params.id, b.category, parseFloat(b.weekly_limit) || 0))
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Upsert income record
app.post('/api/admin/players/:id/income', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await q.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Player not found' });

    const { month, year, gross_weekly, net_weekly, agent_fee_pct, notes } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year required' });

    await q.upsertIncome(
      req.params.id, parseInt(month), parseInt(year),
      parseFloat(gross_weekly) || 0, parseFloat(net_weekly) || 0,
      parseFloat(agent_fee_pct) || 0, notes || ''
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Get player expenses (admin)
app.get('/api/admin/players/:id/expenses', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await q.getExpensesByUserAdmin(req.params.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Add expense for player (admin)
app.post('/api/admin/players/:id/expenses', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { date, description, amount, category, payment_method, notes } = req.body;
    if (!date || !description || amount === undefined || !category) {
      return res.status(400).json({ error: 'date, description, amount, and category required' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });

    const expense = await q.addExpense(req.params.id, date, description.trim(), amt, category, payment_method || 'Card', notes || '');
    res.status(201).json(expense);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Delete any expense (admin)
app.delete('/api/admin/expenses/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const count = await q.deleteExpenseAdmin(req.params.id);
    if (count === 0) return res.status(404).json({ error: 'Expense not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Admin: add savings goal for player
app.post('/api/admin/players/:id/savings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, icon, target_amount, current_amount } = req.body;
    if (!name || !target_amount) return res.status(400).json({ error: 'name and target_amount required' });
    const goal = await q.addSavingsGoal(
      req.params.id, name.trim(), icon || '🎯',
      parseFloat(target_amount), parseFloat(current_amount) || 0
    );
    res.status(201).json(goal);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/savings/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const goal = await q.getSavingsGoalById(req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const { name, icon, target_amount, current_amount } = req.body;
    await q.updateSavingsGoalAdmin(
      name || goal.name, icon || goal.icon,
      parseFloat(target_amount) ?? goal.target_amount,
      parseFloat(current_amount) ?? goal.current_amount,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/savings/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const count = await q.deleteSavingsAdmin(req.params.id);
    if (count === 0) return res.status(404).json({ error: 'Goal not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Reset player password
app.post('/api/admin/players/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = bcrypt.hashSync(newPassword, 12);
    await q.updatePassword(hash, req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Admin overview stats
app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [players, spendRes, savingsTargetRes, savingsCurrentRes] = await Promise.all([
      q.getAllPlayers(),
      pool.query('SELECT SUM(amount) as total FROM expenses WHERE date>=$1', [monthStart]),
      pool.query('SELECT SUM(target_amount) as total FROM savings_goals'),
      pool.query('SELECT SUM(current_amount) as total FROM savings_goals'),
    ]);

    res.json({
      playerCount: players.length,
      totalMonthlySpend: parseFloat(spendRes.rows[0].total) || 0,
      totalSavingsTarget: parseFloat(savingsTargetRes.rows[0].total) || 0,
      totalSavingsCurrent: parseFloat(savingsCurrentRes.rows[0].total) || 0,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ─── BANK STATEMENT PARSING ──────────────────────────────────────────────────

app.post('/api/expenses/parse-statement', requireAuth, async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image || !mimeType) return res.status(400).json({ error: 'image and mimeType required' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'Smart Import is not set up yet. Ask your advisor to add the ANTHROPIC_API_KEY to the app.' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const today = new Date().toISOString().split('T')[0];

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: image } },
          { type: 'text', text: `Analyse this bank statement screenshot from a professional footballer's bank app.

Extract ALL spending transactions (money going OUT — debits, purchases, payments). Do NOT include income, deposits, or transfers in.

Return ONLY a JSON array — no other text, no markdown. Format:
[{"date":"YYYY-MM-DD","description":"merchant or description","amount":12.50,"category":"Food"}]

Category rules (pick the best fit):
- Housing: rent, mortgage, council tax, utilities, broadband, insurance, Sky, Virgin
- Food: restaurants, Nando's, McDonald's, Uber Eats, Deliveroo, JustEat, Tesco, Sainsbury's, Lidl, Asda, any supermarket or takeaway
- Transport: fuel, Uber, taxis, trains, parking, car wash, RAC, AA
- Clothing: Nike, Adidas, JD Sports, ASOS, Zara, any clothes shop
- Entertainment: Netflix, Spotify, Apple, PlayStation, Xbox, cinema, bars, clubs, gaming, holidays, hotels
- Family: money sent to family, child-related, parental support
- Savings: savings transfers, ISA contributions, investments
- Other: everything else

If date is unclear use today: ${today}
If description is unclear use the merchant name shown.
Return [] if no spending transactions are found.` }
        ]
      }]
    });

    const text = response.content.find(b => b.type === 'text')?.text || '';
    let transactions = [];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const VALID_CATS = ['Housing','Food','Transport','Clothing','Entertainment','Family','Savings','Other'];
        transactions = JSON.parse(match[0])
          .filter(t => t.description && t.amount > 0)
          .map(t => ({
            date: typeof t.date === 'string' && t.date.match(/^\d{4}-\d{2}-\d{2}$/) ? t.date : today,
            description: String(t.description).trim().slice(0, 150),
            amount: Math.round(parseFloat(t.amount) * 100) / 100,
            category: VALID_CATS.includes(t.category) ? t.category : 'Other'
          }));
      }
    } catch (e) { console.error('Failed to parse Claude response:', text.slice(0, 300)); }

    res.json({ transactions });
  } catch (e) {
    console.error('parse-statement error:', e.message);
    res.status(500).json({ error: 'Failed to read statement — try a clearer screenshot.' });
  }
});

// ─── HEALTH / KEEPALIVE ──────────────────────────────────────────────────────

app.get('/ping', (req, res) => res.json({ ok: true }));

// ─── ADMIN PANEL ROUTE ───────────────────────────────────────────────────────

app.get('/ffadmin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

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

async function start() {
  await initSchema();
  await seedAdminIfEmpty();
  await seedDefaultPlayers();
  app.listen(PORT, () => {
    console.log(`⚽ FFplayerapp running → http://localhost:${PORT}`);
    console.log(`   Advisor panel → http://localhost:${PORT}/ffadmin`);
  });
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
