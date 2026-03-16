FROM node:24-slim

WORKDIR /app
COPY dist/index.js .

ENTRYPOINT ["node", "/app/index.js"]
