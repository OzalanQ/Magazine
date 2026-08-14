FROM node:20-slim

WORKDIR /app

# 当前项目只剩纯 JS 依赖，无需原生编译工具
COPY package*.json ./
RUN npm ci --omit=dev

# 复制源码
COPY . .

ENV PORT=3000
EXPOSE 3000

# 上传的 PDF / 缩略图 / 数据均落在以下目录
# 部署时务必挂载为持久卷（docker-compose.yml 已配置 ./uploads、./thumbs、./data），否则容器重建会清空数据

CMD ["npm", "start"]
