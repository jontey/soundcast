FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 \
    openssl \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src
COPY scripts ./scripts
COPY certs ./certs

RUN mkdir -p /app/data /app/certs /app/recordings

RUN chmod +x /app/scripts/generate-certs.sh && \
    /app/scripts/generate-certs.sh /app/certs 365

ENV NODE_ENV=production
ENV PORT=3000
ENV HTTPS_PORT=3001
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/soundcast.db
ENV SINGLE_TENANT=false
ENV ANNOUNCED_IP=127.0.0.1
ENV RTC_MIN_PORT=40000
ENV RTC_MAX_PORT=40100
ENV RECORDING_DIR=/app/recordings
ENV RECORDING_RTP_PORT_MIN=50000
ENV RECORDING_RTP_PORT_MAX=50100

EXPOSE 3000
EXPOSE 3001
EXPOSE 40000-40100/udp
EXPOSE 50000-50100/udp

CMD ["node", "src/server.js"]
