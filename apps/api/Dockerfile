FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY package.json README.md ./
RUN mkdir -p /data && chown node:node /data
ENV MUNDUSX_API_HOME=/data PORT=8080
EXPOSE 8080
CMD ["node","src/server.js"]
