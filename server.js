// ============================================================
//  海外云智服每日看板 - 后端服务
//  Tech: Express + sql.js (pure JS SQLite) + JWT + bcrypt
//  改用 sql.js 避免原生模块编译问题，兼容 Render 免费版
//  数据持久化：GitHub 远程备份（解决免费版无 disk 问题）
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

// 全局未捕获异常处理（防止 Railway 上静默崩溃）
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// GitHub 远程备份配置（通过环境变量传入 Token）
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'qinpan0918-lab/daily-board';
const GITHUB_BACKUP_PATH = 'data/backup/board_backup.json';
const GITHUB_BACKUP_BRANCH = 'backup';  // 备份推到独立分支，避免触发 Render 构建
const GITHUB_API_BASE = 'https://api.github.com';

// 数据库路径：本地 data 目录（Render 免费版无持久磁盘）
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'board.db');

// ============================================================
//  种子账号（Seed Account）- 确保账号永远可用
//  如果数据库被清空或密码 hash 错误，启动时自动修复
// ============================================================
const SEED_ACCOUNT = {
  email: '930470286@qq.com',
  password: 'kris2026',
  // bcrypt hash of 'kris2026' (generated with cost=10)
  passwordHash: '\$2b\$10\$rkmoSdybYv1S/e05.OA.6OxyBRuNDYV1kgDN3rjq62AJbdJrFNq/y',
  name: 'kris'
};

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---- Middleware ----
app.use(cors());
app.use(express.json());

// ============================================================
//  数据备份/恢复机制（三层保护）
//  Layer 1: 本地文件系统（同生命周期内有效）
//  Layer 2: GitHub 远程备份（跨部署持久化，核心方案）
//  Layer 3: 启动时自动从 GitHub 拉取恢复
// ============================================================

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 5;
// 远程备份间隔：每 5 分钟
const REMOTE_BACKUP_INTERVAL = 5 * 60 * 1000;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// ---- Layer 1: 本地备份 ----

// 备份数据库：导出当前 DB 为带时间戳的文件
function backupDB(db) {
  try {
    ensureBackupDir();
    const data = db.export();
    const buf = Buffer.from(data);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BACKUP_DIR, `board_${ts}.db`);
    fs.writeFileSync(backupFile, buf);
    
    // 清理旧备份，只保留最近 N 个
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('board_') && f.endsWith('.db'))
      .sort()
      .reverse();
    
    for (let i = MAX_BACKUPS; i < backups.length; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, backups[i]));
    }
    
    console.log(`[BACKUP] 本地备份完成: ${backupFile}`);
  } catch(e) {
    console.error('[BACKUP] 本地备份失败:', e.message);
  }
}

// 恢复数据库：从最新的本地备份文件恢复
function restoreFromLocalBackup() {
  try {
    ensureBackupDir();
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('board_') && f.endsWith('.db'))
      .sort()
      .reverse();
    
    if (backups.length === 0) return null;
    
    const latestBackup = path.join(BACKUP_DIR, backups[0]);
    const buf = fs.readFileSync(latestBackup);
    console.log(`[RESTORE] 从本地备份恢复: ${latestBackup}`);
    return buf;
  } catch(e) {
    console.error('[RESTORE] 本地恢复失败:', e.message);
    return null;
  }
}

// ---- Layer 2: GitHub 远程备份（跨部署持久化）----

// 将数据库内容推送到 GitHub 仓库
// ⚠️ 安全保护：如果当前本地任务数为0但远程有数据，拒绝覆盖（防止空库覆盖历史备份）
async function pushToGitHub(db) {
  if (!GITHUB_TOKEN) {
    console.warn('[GITHUB] 未配置 GITHUB_TOKEN，跳过远程备份');
    return false;
  }

  try {
    // 导出当前数据
    const users = queryAll(db, 'SELECT id, email, password, name, avatar, created_at, last_login FROM users');
    const tasks = queryAll(db, 'SELECT * FROM tasks');

    // ⭐⭐ 关键安全检查：如果本地没有任务数据，先检查远程是否有数据
    // 如果远程有任务而本地为空 → 说明是重部署后的空库，绝对不能覆盖！
    if (tasks.length === 0) {
      console.log('[GITHUB] ⚠️ 本地无任务数据，检查远程备份是否存在有效数据...');
      const remoteData = await pullFromGitHub();
      if (remoteData && remoteData.data && remoteData.data.tasks && remoteData.data.tasks.length > 0) {
        console.error(`[GITHUB] 🛑 拒绝覆盖！远程有 ${remoteData.data.tasks.length} 条任务，本地为空。正在从远程恢复...`);
        // 自动从远程恢复数据到本地
        importRemoteData(db, remoteData);
        // 恢复后重新导出（此时 tasks 应该有数据了）
        const recoveredTasks = queryAll(db, 'SELECT * FROM tasks');
        const recoveredUsers = queryAll(db, 'SELECT id, email, password, name, avatar, created_at, last_login FROM users');
        console.log(`[GITHUB] ✅ 已从远程自动恢复: ${recoveredUsers.length} users, ${recoveredTasks.length} tasks`);
        
        // 用恢复后的数据继续推送（不再递归）
        const backupData = {
          version: '2.0.0',
          exported_at: new Date().toISOString(),
          note: 'auto-recovered from remote before push',
          data: { users: recoveredUsers, tasks: recoveredTasks }
        };
        return await githubPushJSON(backupData);
      } else {
        console.log('[GITHUB] 远程也无任务数据，允许推送空备份（首次使用或确实无数据）');
      }
    }

    // ⭐ 备份前先修复种子账号密码（防止错误 hash 反复覆盖）
    ensureSeedAccount(db);

    // 重新导出（ensureSeedAccount 可能修改了用户表）
    const finalUsers = queryAll(db, 'SELECT id, email, password, name, avatar, created_at, last_login FROM users');
    const finalTasks = queryAll(db, 'SELECT * FROM tasks');

    const backupData = {
      version: '2.0.0',
      exported_at: new Date().toISOString(),
      data: { users: finalUsers, tasks: finalTasks }
    };

    return await githubPushJSON(backupData);
  } catch(e) {
    console.error('[GITHUB] 远程备份异常:', e.message);
    return false;
  }
}

// 实际执行 GitHub Contents API 推送
async function githubPushJSON(backupData) {
  try {
    const content = JSON.stringify(backupData, null, 2);
    const contentB64 = Buffer.from(content).toString('base64');

    // 先尝试获取现有文件的 SHA（用于更新）
    const getUrl = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_PATH}?ref=${GITHUB_BACKUP_BRANCH}`;
    const getRes = await fetch(getUrl, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'daily-board' }
    });
    let sha = null;
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    }

    // 创建或更新文件
    const putUrl = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_PATH}`;
    const body = {
      message: `[auto-backup] ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
      content: contentB64,
      branch: GITHUB_BACKUP_BRANCH
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: { 
        'Authorization': `token ${GITHUB_TOKEN}`, 
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'daily-board'
      },
      body: JSON.stringify(body)
    });

    if (putRes.ok) {
      const taskCount = backupData.data?.tasks?.length || 0;
      const userCount = backupData.data?.users?.length || 0;
      console.log(`[GITHUB] 远程备份成功 (${userCount} users, ${taskCount} tasks)`);
      return true;
    } else {
      const errText = await putRes.text();
      console.error('[GITHUB] 远程备份失败:', putRes.status, errText.slice(0, 200));
      return false;
    }
  } catch(e) {
    console.error('[GITHUB] githubPushJSON 异常:', e.message);
    return false;
  }
}

// 从 GitHub 拉取备份数据
async function pullFromGitHub() {
  if (!GITHUB_TOKEN) {
    console.warn('[GITHUB] 未配置 GITHUB_TOKEN，跳过远程拉取');
    return null;
  }

  try {
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_PATH}?ref=${GITHUB_BACKUP_BRANCH}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'daily-board' }
    });

    if (!res.ok) {
      if (res.status === 404) {
        console.log('[GITHUB] 远程无备份文件（首次使用）');
      } else {
        console.error('[GITHUB] 远程拉取失败:', res.status);
      }
      return null;
    }

    const fileData = await res.json();
    // GitHub API 返回的 content 是 base64 编码
    const jsonStr = Buffer.from(fileData.content, 'base64').toString('utf-8');
    const backupData = JSON.parse(jsonStr);
    
    console.log(`[GITHUB] 远程拉取成功 (${backupData.data?.users?.length || 0} users, ${backupData.data?.tasks?.length || 0} tasks), 更新时间: ${backupData.exported_at}`);
    return backupData;
  } catch(e) {
    console.error('[GITHUB] 远程拉取异常:', e.message);
    return null;
  }
}


// ---- DB Init (async with sql.js) ----
let dbPromise;

async function getDB() {
  if (!dbPromise) {
    const SQL = await initSqlJs();
    let db;
    
    // 数据加载优先级：本地主数据库 > 本地备份 > GitHub远程备份 > 全新空库
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buf);
      console.log('[DB] 从主数据库加载:', DB_PATH);
      
      // ⭐ 关键修复：即使本地有数据库文件，也要检查用户表是否有数据
      // Render 可能保留了空的 board.db 文件（只有表结构没有数据）
      try {
        const userCount = db.exec("SELECT COUNT(*) as cnt FROM users")[0]?.values[0]?.[0] || 0;
        const taskCount = db.exec("SELECT COUNT(*) as cnt FROM tasks")[0]?.values[0]?.[0] || 0;
        console.log(`[DB] 本地数据: ${userCount} users, ${taskCount} tasks`);
        
        if (taskCount === 0) {
          console.log('[DB] ⚠️ 本地无任务数据，尝试从 GitHub 远程拉取...');
          const remoteData = await pullFromGitHub();
          if (remoteData && remoteData.data && (remoteData.data.users.length > 0 || remoteData.data.tasks.length > 0)) {
            importRemoteData(db, remoteData);
            fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
            const newTaskCount = db.exec("SELECT COUNT(*) as cnt FROM tasks")[0]?.values[0]?.[0] || 0;
            console.log(`[DB] ✅ 从 GitHub 远程恢复成功！已写入主数据库（${newTaskCount} 条任务）`);
          } else {
            console.log('[DB] 远程也无备份数据，使用空数据库');
          }
        }
      } catch(e) {
        console.warn('[DB] 检查数据量失败:', e.message);
      }
    } else {
      // 主数据库不存在 → 尝试本地备份
      let localBuf = restoreFromLocalBackup();
      if (localBuf) {
        db = new SQL.Database(localBuf);
        fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
        console.log('[DB] 从本地备份恢复！数据已写入主数据库');
      } else {
        // 本地也没有 → 尝试 GitHub 远程拉取
        console.log('[DB] 本地无数据，尝试从 GitHub 远程拉取...');
        const remoteData = await pullFromGitHub();
        if (remoteData && remoteData.data && (remoteData.data.users.length > 0 || remoteData.data.tasks.length > 0)) {
          db = new SQL.Database();
          createTables(db);
          importRemoteData(db, remoteData);
          fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
          const initTaskCount = db.exec("SELECT COUNT(*) as cnt FROM tasks")[0]?.values[0]?.[0] || 0;
          console.log(`[DB] ✅ 从 GitHub 远程恢复成功！数据已写入主数据库（${initTaskCount} 条任务）`);
        } else {
          db = new SQL.Database();
          console.log('[DB] 创建全新数据库（无任何备份数据）');
        }
      }
    }

    // Users & Tasks tables
    createTables(db);

    // ⭐ 种子账号修复：确保 930470286@qq.com 永远可用
    ensureSeedAccount(db);

    console.log('[DB] Initialized at', DB_PATH);
    
    // Auto-save periodically and on shutdown + 定期自动备份（本地+远程）
    const saveDB = () => {
      try { const data = db.export(); const buf = Buffer.from(data); fs.writeFileSync(DB_PATH, buf); }
      catch(e) {}
    };
    
    // 每 10 秒保存一次到本地
    setInterval(saveDB, 10000);
    
    // 每 5 分钟：本地备份 + GitHub 远程备份
    setInterval(() => {
      backupDB(db);
      pushToGitHub(db);
    }, REMOTE_BACKUP_INTERVAL);
    
    // 启动后延迟做一次远程备份（给足够时间让数据先稳定）
    // 注意：pushToGitHub 现在有空数据保护机制，不会用空库覆盖远程
    setTimeout(() => pushToGitHub(db), 30000);  // 延长到30秒
    
    // 关闭时保存 + 备份
    process.on('SIGINT', async () => { 
      saveDB(); 
      backupDB(db); 
      await pushToGitHub(db);
      process.exit(0); 
    });
    process.on('SIGTERM', async () => { 
      saveDB(); 
      backupDB(db); 
      await pushToGitHub(db);
      process.exit(0); 
    });

    dbPromise = Promise.resolve(db);
  }
  return dbPromise;
}

// 建表函数（复用）
function createTables(db) {
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
      start_date TEXT,
      end_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // 迁移：为已有表添加跨天字段（如果不存在）
  try {
    const cols = queryAll(db, "PRAGMA table_info(tasks)");
    const colNames = cols.map(c => c.name);
    if (!colNames.includes('start_date')) {
      db.run(`ALTER TABLE tasks ADD COLUMN start_date TEXT`);
      console.log('[DB] 迁移: 已添加 start_date 字段');
    }
    if (!colNames.includes('end_date')) {
      db.run(`ALTER TABLE tasks ADD COLUMN end_date TEXT`);
      console.log('[DB] 迁移: 已添加 end_date 字段');
    }
  } catch(e) {
    console.warn('[DB] 迁移跨天字段失败（可能已存在）:', e.message);
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON tasks(user_id, task_date)`);
}

// 从远程备份数据导入到数据库（复用逻辑）
function importRemoteData(db, remoteData) {
  // 导入用户数据
  for (const user of remoteData.data.users) {
    db.run(`INSERT OR REPLACE INTO users (id, email, password, name, avatar, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user.id, user.email, user.password, user.name || '', user.avatar || '', user.created_at, user.last_login]);
  }
  // 导入任务数据
  for (const task of remoteData.data.tasks) {
    db.run(`INSERT OR REPLACE INTO tasks (id, user_id, title, category, done, start_time, end_time, task_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.user_id, task.title, task.category || '工作', task.done || 0, task.start_time, task.end_time, task.task_date, task.created_at, task.updated_at]);
  }
}

// 种子账号确保机制：如果种子账号不存在或密码 hash 不匹配，自动修复
function ensureSeedAccount(db) {
  try {
    const existing = queryGet(db, 'SELECT id, password FROM users WHERE email = ?', [SEED_ACCOUNT.email]);
    if (!existing) {
      // 账号不存在 → 创建
      db.run(`INSERT OR IGNORE INTO users (email, password, name) VALUES (?, ?, ?)`,
        [SEED_ACCOUNT.email, SEED_ACCOUNT.passwordHash, SEED_ACCOUNT.name]);
      console.log(`[SEED] 已创建种子账号: ${SEED_ACCOUNT.email}`);
    } else {
      // 账号存在 → 验证密码 hash 是否正确（用 bcrypt.compare 异步检查）
      // 这里我们直接用同步方式：如果 hash 不是预期的格式，就覆盖
      // 因为 sql.js 是同步的，我们无法在这里调用 bcrypt.compare
      // 所以采用策略：每次启动都用正确的 hash 覆盖（幂等操作）
      db.run(`UPDATE users SET password = ?, name = ? WHERE email = ?`,
        [SEED_ACCOUNT.passwordHash, SEED_ACCOUNT.name, SEED_ACCOUNT.email]);
      console.log(`[SEED] 已修复种子账号密码: ${SEED_ACCOUNT.email}`);
    }
  } catch(e) {
    console.error('[SEED] 种子账号修复失败:', e.message);
  }
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


// PUT /api/auth/change-password — 修改密码
app.put('/api/auth/change-password', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  try {
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '请输入当前密码和新密码' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码至少 6 位' });
    }
    const db = await getDB();
    const user = queryGet(db, 'SELECT * FROM users WHERE id = ?', [payload.userId]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) {
      return res.status(400).json({ error: '当前密码不正确' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    queryRun(db, 'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hash, user.id]);
    // 同步更新种子账号 hash（如果是种子账号改密码）
    if (user.email === SEED_ACCOUNT.email) {
      SEED_ACCOUNT.passwordHash = hash;
    }
    const newToken = jwt.sign(
      { userId: user.id, email: user.email, name: user.name || '' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ message: '密码修改成功', token: newToken });
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

// GET /api/tasks?date=2024-04-08 — 获取某天任务（含跨天事项）
app.get('/api/tasks', authMiddleware, async (req, res) => {
  const db = await getDB();
  const { date } = req.query;
  let tasks;
  if (date) {
    // 查询逻辑：
    // 1. task_date == date（普通单日任务，或跨天任务的起始日）
    // 2. start_date <= date <= end_date（跨天任务的覆盖范围）
    tasks = queryAll(db, `
      SELECT * FROM tasks 
      WHERE user_id = ? 
        AND (
          task_date = ? 
          OR (start_date IS NOT NULL AND start_date != '' AND end_date IS NOT NULL AND end_date != '' AND ? >= start_date AND ? <= end_date)
        )
      ORDER BY created_at ASC
    `, [req.user.userId, date, date, date]);
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
  const { title, category, done, startTime, endTime, date, startDate, endDate } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: '事项内容不能为空' });
  }
  
  const taskDate = date || new Date().toISOString().slice(0, 10);
  // 跨天：如果有 startDate/endDate，用它们；否则退化为单日（start_date=end_date=null）
  const sd = startDate && startDate !== taskDate ? startDate : null;
  const ed = endDate && endDate !== taskDate ? endDate : null;
  
  const db = await getDB();

  queryRun(db, `
    INSERT INTO tasks (user_id, title, category, done, start_time, end_time, task_date, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    req.user.userId,
    title.trim(),
    category || '工作',
    done ? 1 : 0,
    startTime || null,
    endTime || null,
    taskDate,
    sd,
    ed
  ]);

  const task = queryGet(db, 'SELECT * FROM tasks WHERE rowid = last_insert_rowid()');
  res.json({ task: { ...task, done: task.done === 1 }, message: '创建成功' });
});

// PUT /api/tasks/:id — 更新任务（支持跨天字段）
app.put('/api/tasks/:id', authMiddleware, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const { title, category, done, startTime, endTime, startDate, endDate } = req.body;
  const db = await getDB();

  // Verify ownership
  const existing = queryGet(db, 'SELECT * FROM tasks WHERE id = ? AND user_id = ?', [taskId, req.user.userId]);
  if (!existing) {
    return res.status(404).json({ error: '事项不存在' });
  }

  // 跨天日期处理：如果传了 startDate/endDate 就更新，否则保持原值
  const sd = startDate !== undefined ? (startDate || null) : existing.start_date;
  const ed = endDate !== undefined ? (endDate || null) : existing.end_date;

  queryRun(db, `
    UPDATE tasks SET title=?, category=?, done=?, start_time=?, end_time=?, start_date=?, end_date=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `, [
    title !== undefined ? title.trim() : existing.title,
    category !== undefined ? category : existing.category,
    done !== undefined ? (done ? 1 : 0) : existing.done,
    startTime !== undefined ? startTime : existing.start_time,
    endTime !== undefined ? endTime : existing.end_time,
    sd,
    ed,
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
//  BACKUP / RESTORE APIs (require auth)
// ============================================================

// POST /api/backup — 手动触发备份（本地+远程）
app.post('/api/backup', authMiddleware, async (req, res) => {
  const db = await getDB();
  backupDB(db);
  
  // 同时触发远程备份
  const remoteOk = await pushToGitHub(db);
  
  // 列出现有本地备份
  try {
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('board_') && f.endsWith('.db'))
      .sort()
      .reverse();
    res.json({ 
      message: '备份完成', 
      local: backups.slice(0, 5),
      remote: remoteOk ? '已推送至 GitHub' : 'GitHub 备份失败（检查 Token 配置）'
    });
  } catch(e) {
    res.json({ message: '本地备份完成', remote: remoteOk ? 'OK' : 'FAIL' });
  }
});

// GET /api/backups — 查看所有备份
app.get('/api/backups', authMiddleware, async (req, res) => {
  try {
    ensureBackupDir();
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('board_') && f.endsWith('.db'))
      .sort()
      .reverse()
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: (stat.size / 1024).toFixed(1) + 'KB', time: stat.mtime.toISOString() };
      });
    res.json({ backups });
  } catch(e) {
    res.json({ backups: [] });
  }
});

// POST /api/restore — 从指定备份恢复
app.post('/api/restore', authMiddleware, async (req, res) => {
  const { backupFile } = req.body;
  if (!backupFile) {
    return res.status(400).json({ error: '需要指定 backupFile' });
  }
  
  const targetPath = path.join(BACKUP_DIR, backupFile);
  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: '备份文件不存在' });
  }
  
  try {
    const buf = fs.readFileSync(targetPath);
    // 写入主数据库路径（下次启动会自动加载）
    fs.writeFileSync(DB_PATH, buf);
    
    // 同时重置内存中的数据库连接，让下一次请求使用新数据
    if (dbPromise) {
      const SQL = await initSqlJs();
      const newDb = new SQL.Database(buf);
      // 重新建表确保结构完整
      newDb.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      )`);
      newDb.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT DEFAULT '工作',
        done INTEGER DEFAULT 0,
        start_time TEXT,
        end_time TEXT,
        task_date TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);
      dbPromise = Promise.resolve(newDb);
    }
    
    res.json({ message: `已从 ${backupFile} 恢复数据` });
  } catch(e) {
    res.status(500).json({ error: '恢复失败: ' + e.message });
  }
});

// GET /api/export-db — 下载数据库文件（JSON 格式）
app.get('/api/export-db', authMiddleware, async (req, res) => {
  const db = await getDB();
  try {
    const users = queryAll(db, 'SELECT * FROM users');
    const tasks = queryAll(db, 'SELECT * FROM tasks');
    res.json({
      exported_at: new Date().toISOString(),
      version: '2.0.0',
      data: { users, tasks }
    });
  } catch(e) {
    res.status(500).json({ error: '导出失败' });
  }
});

// GET /api/backup-status — 查看备份状态（本地+远程）
app.get('/api/backup-status', authMiddleware, async (req, res) => {
  const db = await getDB();
  
  // 本地备份列表
  let localBackups = [];
  try {
    ensureBackupDir();
    localBackups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('board_') && f.endsWith('.db'))
      .sort()
      .reverse()
      .map(f => ({ name: f, type: 'local' }));
  } catch(e) {}
  
  // 远程备份状态
  let remoteStatus = null;
  if (GITHUB_TOKEN) {
    try {
      const remoteData = await pullFromGitHub();
      if (remoteData) {
        remoteStatus = {
          ok: true,
          exported_at: remoteData.exported_at,
          users: remoteData.data?.users?.length || 0,
          tasks: remoteData.data?.tasks?.length || 0
        };
      } else {
        remoteStatus = { ok: false, reason: '远程无备份数据' };
      }
    } catch(e) {
      remoteStatus = { ok: false, reason: e.message };
    }
  } else {
    remoteStatus = { ok: false, reason: '未配置 GITHUB_TOKEN' };
  }
  
  // 当前数据库数据量
  const userCount = queryGet(db, 'SELECT COUNT(*) as cnt FROM users').cnt;
  const taskCount = queryGet(db, 'SELECT COUNT(*) as cnt FROM tasks').cnt;
  
  res.json({
    local: { backups: localBackups.slice(0, 5), count: localBackups.length },
    remote: remoteStatus,
    current: { users: userCount, tasks: taskCount, db_path: DB_PATH }
  });
});


// ============================================================
//  HEALTH CHECK & SERVE FRONTEND
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '2.0.0', dbReady: !!dbPromise });
});

// Serve static frontend in production
const frontendPath = path.join(__dirname, 'public');
app.use(express.static(frontendPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ---- Start ----
// ⭐ 关键修复：先启动 HTTP 监听，再初始化数据库
// Railway/Render 有启动超时限制，如果 DB 初始化（含 GitHub 拉取）太慢，
// 端口没有及时绑定就会被判定为 "Application failed to respond"
const HOST = '0.0.0.0';  // Railway 要求绑定所有网卡，不能用默认 127.0.0.1
app.listen(PORT, HOST, () => {
  console.log(`[STARTUP] Server listening on ${HOST}:${PORT}`);
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  🌐 海外云智服每日看板 - 服务端启动     ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port:   http://${HOST}:${PORT}          `);
  console.log('║  Auth:   JWT Token                      ');
  console.log('║  DB:     sql.js (pure JS SQLite)         ');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // 端口已绑定后，再异步初始化数据库
  getDB().then(() => {
    console.log('[STARTUP] 数据库初始化完成，服务就绪');
  }).catch(err => {
    console.error('[STARTUP] 数据库初始化失败:', err.message);
  });
});
