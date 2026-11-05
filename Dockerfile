FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/tsconfig.json frontend/index.html frontend/*.ts frontend/styles.css ./
COPY src/domain.ts /app/src/domain.ts
RUN npm run build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=frontend-build --chown=node:node /app/frontend/dist ./frontend/dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
