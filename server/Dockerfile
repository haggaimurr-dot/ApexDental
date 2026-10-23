FROM node:24-bookworm-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY miniprogram/lib/ /app/miniprogram/lib/
ENV NODE_ENV=production APEX_HOST=0.0.0.0 APEX_PORT=8787 APEX_DATA_DIR=/data APEX_DEMO_AUTH=0
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.js"]
