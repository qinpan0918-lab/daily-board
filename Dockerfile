FROM node:18-slim

WORKDIR /app

# 复制后端代码和前端
COPY server/ ./server/
COPY public/ ./public/

# 安装依赖（纯JS模块，无需编译）
RUN cd server && npm install --production

# 创建数据目录
RUN mkdir -p /app/server/data

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "server/server.js"]
