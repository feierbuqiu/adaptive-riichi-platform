FROM node:25-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV SOURCE_ROOT=/opt/adaptive-test-source
ENV DB_PATH=/var/lib/adaptive-test/app.sqlite

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /var/lib/adaptive-test \
  && chown -R node:node /var/lib/adaptive-test /app

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
