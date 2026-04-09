# 长期记忆

## 项目信息
- **海外云智服每日看板**：全栈看板系统，Express + sql.js + JWT，已部署到 Render 公网
  - 公网地址：https://daily-board.onrender.com
  - GitHub：https://github.com/qinpan0918-lab/daily-board（用户名 qinpan0918-lab）
  - 技术栈：Express + sql.js（纯JS SQLite）+ JWT + bcryptjs
  - ⚠️ 重要经验：Render 免费版不支持原生C++模块编译（better-sqlite3不可用），必须用纯JS替代方案

## 用户偏好
- 部署偏好：用户没有GitHub账号，已注册并指导完成首次使用
- 文档风格：偏好可执行的具体内容，表格化表达
- **部署标准化**：用户要求后续所有项目按统一SOP流程发布，不要在部署上浪费时间
  - Skill位置：~/.workbuddy/skills/deploy-render-standard/
  - 触发词："发布上线"、"部署到公网"、"部署到Render"

## 踩坑经验库
- **Render 免费版部署限制**：
  - 文件系统只读（Read-only file system），不能用 apt-get install
  - 不支持 better-sqlite3 等 C++ 原生 Node 模块
  - **不支持 Persistent Disk（仅付费版支持）**——这是数据反复丢失的根本原因
  - 解决方案：用 sql.js（纯 JS WASM 实现）替代数据库驱动
  - 数据持久化方案：GitHub Contents API 远程备份（每5分钟推送到仓库，启动时自动拉取恢复）
  - Docker 模式需要在创建服务时选择，中途不能从 Node 切换为 Docker

### 看板账号信息
- **930470286@qq.com** / 密码 **kris2026**
- 用户名：kris，user_id: 1
- ⚠️ 该账号已多次被 Render 重部署清除，依赖 GitHub 远程备份恢复

## 标准部署流程（SOP 要点）
1. package.json 必须放根目录（含 dependencies + start script）
2. 禁用 C++ 原生模块，数据库用 sql.js
3. Build: `npm install` / Start: `node server.js`
4. 端口必须用 process.env.PORT（Render 分配10000）
5. GitHub 推送 → Render 新建 Web Service → 填命令 → 完成
