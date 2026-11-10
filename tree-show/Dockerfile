# Optional: Docker instead of the systemd install
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js dither.js ha.js ./
COPY public ./public
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
