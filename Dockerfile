FROM node:24-alpine
ARG GIT_COMMIT=unknown
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3737 AUTH_DB=/data/nutboard.db BUILD_COMMIT=$GIT_COMMIT
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN install -d -o node -g node /data
VOLUME /data
EXPOSE 3737
USER node
CMD ["node", "src/server.ts"]
