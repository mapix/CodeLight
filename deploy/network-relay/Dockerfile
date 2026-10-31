ARG NODE_IMAGE=node:24.22.2-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY src/network/ ./src/network/
USER node
EXPOSE 8081
CMD ["node", "src/network/relay-main.mjs"]
