# 🌐 海外云智服每日看板 — 部署指南

## 项目结构

```
项目根目录/
├── server/          # 后端服务（Node.js + Express）
│   ├── package.json
│   └── server.js
├── public/          # 前端静态文件
│   └── index.html   # 完整的单页应用（登录/注册/看板/日历/导出）
└── README.md        # 本文档
```

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| **后端** | Node.js + Express | RESTful API 服务 |
| **数据库** | SQLite (better-sqlite3) | 零配置，单文件存储 |
| **认证** | JWT + bcryptjs | 邮箱注册/登录，密码加密 |
| **前端** | 原生 HTML/CSS/JS | 无框架依赖，单文件 |
| **部署** | Render / Railway / Vercel | 免费托管 |

---

## 方案一：Render 部署（推荐 ⭐ 最简单）

### 第一步：准备代码

确保你的项目结构如下：

```
daily-board/
├── server/
│   ├── package.json
│   └── server.js
├── public/
│   └── index.html
└── (可选) .gitignore
```

### 第二步：推送到 GitHub

1. 在 GitHub 创建一个新仓库 `daily-board`
2. 在本地执行：

```bash
cd daily-board
git init
git add .
git commit -m "init: 海外云智服每日看板"
git remote add origin https://github.com/你的用户名/daily-board.git
git push -u origin main
```

### 第三步：在 Render 上创建服务

1. 访问 [render.com](https://render.com)，用 GitHub 登录（免费）
2. 点击 **"New +"** → **"Web Service"**
3. 选择你刚推送的 `daily-board` 仓库
4. **关键配置**：

| 配置项 | 值 |
|--------|-----|
| **Runtime** | Node |
| **Build Command** | `cd server && npm install` |
| **Start Command** | `cd server && node server.js` |
| **Instance Type** | Free（免费） |

5. 点击 **"Create Web Service"**

6. 等待 1-2 分钟构建完成 → 你会获得一个类似：
   ```
   https://your-app.onrender.com
   ```

7. 打开这个链接就能看到登录/注册页面了！🎉

### 第四步：（可选）绑定自定义域名

在 Render 控制台的 **Settings → Custom Domains** 添加你的域名。
需要先将域名的 DNS CNAME 指向 Render 提供的地址。

---

## 方案二：Railway 部署

1. 访问 [railway.app](https://railway.app)，用 GitHub 登录
2. **New Project** → **Deploy from GitHub repo** → 选择仓库
3. Railway 会自动检测到 `package.json` 并配置
4. 修改 Start Command 为：`cd server && node server.js`
5. 点击 **Deploy**，完成后获得 URL

---

## 方案三：本地运行

```bash
cd server
npm install
node server.js
```

然后浏览器打开 `http://localhost:3000`

> 注意：`public/index.html` 会由 Express 的 static 中间件自动提供。

---

## API 文档

所有 API 都需要 `Authorization: Bearer <token>` 头部。

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 {email, password, name?} |
| POST | `/api/auth/login` | 登录 {email, password} |
| GET | `/api/auth/me` | 获取当前用户信息 |

### 任务

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks?date=2024-04-08` | 获取某天任务列表 |
| GET | `/api/tasks` | 获取全部任务 |
| POST | `/api/tasks` | 创建任务 {title, category?, done?, startTime?, endTime?, date?} |
| PUT | `/api/tasks/:id` | 更新任务 {title?, category?, done?, startTime?, endTime?} |
| DELETE | `/api/tasks/:id` | 删除任务 |
| DELETE | `/api/tasks/date/:date/clear-done` | 清除某天已完成 |

### 统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats?date=2024-04-08` | 获取统计信息 |

---

## 数据库说明

- 数据库文件位于 `server/data/board.db`
- **⚠️ 重要**: Render/Railway 免费版重启后会丢失数据。如需持久化，建议后续升级 PostgreSQL 或挂载持久磁盘。

### 升级为 PostgreSQL（推荐生产环境使用）

当数据量增大或需要多实例时：

1. 在 Render 上添加 **PostgreSQL** Addon（免费额度够用）
2. 将 `server.js` 中的 `better-sqlite3` 替换为 `pg`
3. 修改 SQL 语法适配 PostgreSQL

---

## 团队成员使用方式

部署完成后，每个成员只需：

1. 打开网站链接
2. 点击「注册」，输入自己的邮箱和密码
3. 开始使用自己的每日看板

每个用户的数据完全隔离，互不可见。

---

## 后续可扩展功能

- [ ] 微信扫码登录（需已备案域名 + 微信开放平台资质）
- [ ] 团队共享看板（管理员可查看成员进度）
- [ ] 数据报表导出（周报/月报自动生成）
- [ ] 提醒通知（邮件/微信提醒待办事项）
- [ ] PostgreSQL 持久化存储升级
