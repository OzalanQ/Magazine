FROM node:20

WORKDIR /app

# 安装原生模块可能需要的编译工具与系统库（@napi-rs/canvas / pdfjs-dist）
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# 仅安装生产依赖
COPY package*.json ./
RUN npm ci --omit=dev

# 复制源码
COPY . .

ENV PORT=3000
EXPOSE 3000

# 上传的 PDF / 缩略图 / 数据均落在以下目录，部署时务必挂载为持久卷
VOLUME ["/app/uploads", "/app/thumbs", "/app/data"]

CMD ["npm", "start"]
