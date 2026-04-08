// ============================================================
//  海外云智服每日看板 - 后端服务
//  Tech: Express + sql.js (pure JS SQLite) + JWT + bcrypt
//  改用 sql.js 避免原生模块编译问题，兼容 Render 免费版
// ============================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'daily-board-secret-key-2024';
const DB_PATH = path.join(__dirname, 'data', 'board.db');

// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// ---- Middleware ----
app.use(cors());
app.use(express.json());

// ---- DB Init (async with sql.js) ----
let dbPromise;

async function getDB() {
  if (!dbPromise) {
    const SQL = await initSqlJs();
    let db;
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }

    // Users table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      )
    `);

    // Tasks table (per-user)
    db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT DEFAULT '工作',
        done INTEGER DEFAULT 0,
        start_time TEXT,
        end_time TEXT,
        task_date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Index for fast queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, task_date)`);

    console.log('[DB] Initialized at', DB_PATH);
    
    // Auto-save periodically and on shutdown
    const saveDB = () => {
      try { const data = db.export(); const buf = Buffer.from(data); fs.writeFileSync(DB_PATH, buf); }
      catch(e) {}
    };
    setInterval(saveDB, 10000); // Save every 10 seconds
    process.on('SIGINT', () => { saveDB(); process.exit(0); });
    process.on('SIGTERM', () => { saveDB(); process.exit(0); });

    dbPromise = Promise.resolve(db);
  }
  return dbPromise;
}

// Helper: run a query and return results as array of objects
function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryGet(db, sql, params = []) {
  const rows = queryAll(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function queryRun(db, sql, params = []) {
  db.run(sql, params);
  return { changes: db.getRowsModified(), lastInsertRowid: db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0] };
}


// ============================================================
//  AUTH APIs
// ============================================================

// POST /api/auth/register — 注册
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6个字符' });
  }

  const db = await getDB();

  // Check if exists
  const existing = queryGet(db, 'SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    return res.status(409).json({ error: '该邮箱已注册' });
  }

  // Hash & insert
  const hash = await bcrypt.hash(password, 10);
  queryRun(db, 'INSERT INTO users (email, password, name) VALUES (?, ?, ?)', [email, hash, name || email.split('@')[0]]);

  const user = queryGet(db, 'SELECT id, email, name FROM users WHERE rowid = last_insert_rowid()');
  const token = jwt.sign(
    { userId: user.id, email: user.email, name: user.name || '' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    message: '注册成功',
    token,
    user: { id: user.id, email: user.email, name: user.name || '' }
  });
});

// POST /api/auth/login — 登录
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }

  const db = await getDB();
  const user = queryGet(db, 'SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  // Update last login
  queryRun(db, 'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

  const token = jwt.sign(
    { userId: user.id, email: user.email, name: user.name || '' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({
    message: '登录成功',
    token,
    user: { id: user.id, email: user.email, name: user.name || '' }
  });
});

// GET /api/auth/me — 获取当前用户信息
app.get('/api/auth/me', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  try {
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);
    const db = await getDB();
    const user = queryGet(db, 'SELECT id, email, name, avatar, created_at, last_login FROM users WHERE id = ?', [payload.userId]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    res.json({ user });
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
});


// Auth Middleware for task APIs
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  try {
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}


// ============================================================
//  TASK APIs (all require auth)
// ============================================================

// GET /api/tasks?date=2024-04-08 — 获取某天任务
app.get('/api/tasks', authMiddleware, async (req, res) => {
  const db = await getDB();
  const { date } = req.query;
  let tasks;
  if (date) {
    tasks = queryAll(db, 'SELECT * FROM tasks WHERE user_id = ? AND task_date = ? ORDER BY created_at ASC', [req.user.userId, date]);
  } else {
    tasks = queryAll(db, 'SELECT * FROM tasks WHERE user_id = ? ORDER BY task_date DESC, created_at ASC', [req.user.userId]);
  }
  // Convert SQLite integers to JS booleans
  const normalized = tasks.map(t => ({
    ...t,
    done: t.done === 1
  }));
  res.json({ tasks: normalized });
});

// POST /api/tasks — 创建任务
app.post('/api/tasks', authMiddleware, async (req, res) => {
  const { title, category, done, startTime, endTime, date } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: '事项内容不能为空' });
  }
  
  const taskDate = date || new Date().toISOString().slice(0, 10);
  const db = await getDB();

  queryRun(db, `
    INSERT INTO tasks (user_id, title, category, done, start_time, end_time, task_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    req.user.userId,
    title.trim(),
    category || '工作',
    done ? 1 : 0,
    startTime || null,
    endTime || null,
    taskDate
  ]);

  const task = queryGet(db, 'SELECT * FROM tasks WHERE rowid = last_insert_rowid()');
  res.json({ task: { ...task, done: task.done === 1 }, message: '创建成功' });
});

// PUT /api/tasks/:id — 更新任务
app.put('/api/tasks/:id', authMiddleware, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const { title, category, done, startTime, endTime } = req.body;
  const db = await getDB();

  // Verify ownership
  const existing = queryGet(db, 'SELECT * FROM tasks WHERE id = ? AND user_id = ?', [taskId, req.user.userId]);
  if (!existing) {
    return res.status(404).json({ error: '事项不存在' });
  }

  queryRun(db, `
    UPDATE tasks SET title=?, category=?, done=?, start_time=?, end_time=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `, [
    title !== undefined ? title.trim() : existing.title,
    category !== undefined ? category : existing.category,
    done !== undefined ? (done ? 1 : 0) : existing.done,
    startTime !== undefined ? startTime : existing.start_time,
    endTime !== undefined ? endTime : existing.end_time,
    taskId
  ]);

  const updated = queryGet(db, 'SELECT * FROM tasks WHERE id = ?', [taskId]);
  res.json({ task: { ...updated, done: updated.done === 1 }, message: '更新成功' });
});

// DELETE /api/tasks/:id — 删除任务
app.delete('/api/tasks/:id', authMiddleware, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const db = await getDB();

  const existing = queryGet(db, 'SELECT * FROM tasks WHERE id = ? AND user_id = ?', [taskId, req.user.userId]);
  if (!existing) {
    return res.status(404).json({ error: '事项不存在' });
  }

  queryRun(db, 'DELETE FROM tasks WHERE id = ?', [taskId]);
  res.json({ message: '删除成功' });
});

// DELETE /api/tasks/date/:date/clear-done — 清除某天已完成
app.delete('/api/tasks/date/:date/clear-done', authMiddleware, async (req, res) => {
  const { date } = req.params;
  const db = await getDB();
  
  db.run('DELETE FROM tasks WHERE user_id = ? AND task_date = ? AND done = 1', [req.user.userId, date]);
  const result = { changes: db.getRowsModified() };

  res.json({ message: `已清除 ${result.changes} 条已完成事项` });
});


// ============================================================
//  STATS API
// ============================================================

// GET /api/stats?date=2024-04-08 — 获取统计
app.get('/api/stats', authMiddleware, async (req, res) => {
  const { date } = req.query;
  const userId = req.user.userId;
  const db = await getDB();

  let whereSql = 'WHERE user_id = ?';
  let params = [userId];
  if (date) {
    whereSql += ' AND task_date = ?';
    params.push(date);
  }

  const total = queryGet(db, `SELECT COUNT(*) as cnt FROM tasks ${whereSql}`, params).cnt;
  const doneCount = queryGet(db, `SELECT COUNT(*) as cnt FROM tasks ${whereSql} AND done=1`, params).cnt;
  const pendingCount = total - doneCount;
  const rate = total > 0 ? Math.round(doneCount / total * 100) : 0;

  // Global stats (across all dates)
  const globalTotal = queryGet(db, 'SELECT COUNT(*) as cnt FROM tasks WHERE user_id=?', [userId]).cnt;
  const globalDone = queryGet(db, 'SELECT COUNT(*) as cnt FROM tasks WHERE user_id=? AND done=1', [userId]).cnt;
  const daysWithData = queryGet(db, 'SELECT COUNT(DISTINCT task_date) as cnt FROM tasks WHERE user_id=?', [userId]).cnt;

  res.json({
    daily: { total, done: doneCount, pending: pendingCount, rate },
    global: { total: globalTotal, done: globalDone, daysWithData }
  });
});


// ============================================================
//  HEALTH CHECK & SERVE FRONTEND
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '2.0.0' });
});

// Serve static frontend in production
const frontendPath = path.join(__dirname, '..', 'public');
app.use(express.static(frontendPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ---- Start ----
getDB().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║  🌐 海外云智服每日看板 - 服务端启动     ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  Port:   http://localhost:${PORT}          `);
    console.log('║  Auth:   JWT Token                      ');
    console.log('║  DB:     sql.js (pure JS SQLite)         ');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
  });
});
