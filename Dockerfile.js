# Fit-Rend-Base app image (works on Oracle's Arm servers and on normal Intel/AMD servers)
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY next.config.js middleware.js instrumentation.js ./
COPY app ./app
COPY lib ./lib
RUN npm run build && mkdir -p /data /backups && chown node:node /data /backups
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data BACKUP_DIR=/backups
USER node
EXPOSE 3000
CMD ["npm", "start"]
