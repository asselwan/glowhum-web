FROM node:22-alpine

WORKDIR /app

COPY . .

ENV DROP_ROOT=/data/drops
ENV PORT=80

EXPOSE 80

CMD ["node", "server.mjs"]
