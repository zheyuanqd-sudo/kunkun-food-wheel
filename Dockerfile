FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml server.mjs ./
RUN npm install --omit=dev
COPY public ./public
COPY data ./data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
