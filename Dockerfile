FROM node:20-slim

WORKDIR /app

# 仅安装生产依赖
COPY package*.json ./
RUN npm install --omit=dev

# 复制源码
COPY . .

ENV PORT=3000
EXPOSE 3000

# 上传的 PDF / 缩略图 / 数据均落在以下目录，部署时务必挂载为持久卷
VOLUME ["/app/uploads", "/app/thumbs", "/app/data"]

CMD ["npm", "start"]
