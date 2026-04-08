FROM node:18-slim

# 安装 better-sqlite3 编译所需的系统依赖
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制后端代码
COPY server/ ./server/
COPY public/ ./public/

# 安装依赖并编译原生模块
RUN cd server && npm install --build-from-source

# 创建数据目录（用于持久化 SQLite 数据库）
RUN mkdir -p /app/server/data

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "server/server.js"]
