FROM node:18-slim

WORKDIR /app

# 先复制 package 文件安装依赖（利用 Docker 缓存）
COPY package.json package-lock.json* ./

# 安装依赖（纯JS模块，无需编译）
RUN npm install --production

# 复制所有业务代码
COPY server.js ./
COPY public/ ./public/
COPY data/ ./data/

ENV NODE_ENV=production

# Railway 会注入 PORT 环境变量，这里只是文档性声明
EXPOSE 3000

CMD ["node", "server.js"]
