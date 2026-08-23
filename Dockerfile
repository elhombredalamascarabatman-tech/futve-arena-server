FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY physics.js game.js index.js ./

ENV NODE_ENV=production
# Cloud Run inyecta la variable PORT automáticamente; el servidor la respeta (ver index.js).
EXPOSE 8080

CMD ["node", "index.js"]
