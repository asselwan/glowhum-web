FROM node:22-alpine

RUN apk add --no-cache poppler-utils

WORKDIR /app

COPY . .

ENV DROP_ROOT=/data/drops
ENV GLOWHUM_DROPS_DIR=/data
ENV PORT=80

EXPOSE 80

CMD ["node", "server.mjs"]
