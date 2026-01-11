# Build stage
FROM node:22-bookworm AS builder

# Install mediasoup dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Production stage
FROM node:22-bookworm-slim

# Install runtime dependencies for mediasoup, openssl for cert generation, and ffmpeg for recording
RUN apt-get update && apt-get install -y \
    python3 \
    openssl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts
COPY certs ./certs

# Create directories for database, certificates, and recordings
RUN mkdir -p /app/data /app/certs /app/recordings

# Generate self-signed TLS certificate at build time
RUN chmod +x /app/scripts/generate-certs.sh && \
    /app/scripts/generate-certs.sh /app/certs 365

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HTTPS_PORT=3001
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/soundcast.db

# Single-tenant mode (for air-gapped deployments)
ENV SINGLE_TENANT=false

# WebRTC/mediasoup settings
ENV ANNOUNCED_IP=127.0.0.1
ENV RTC_MIN_PORT=40000
ENV RTC_MAX_PORT=40100

# Recording settings
ENV RECORDING_DIR=/app/recordings
ENV RECORDING_RTP_PORT_MIN=50000
ENV RECORDING_RTP_PORT_MAX=50100

# Expose HTTP port
EXPOSE 3000

# Expose HTTPS port
EXPOSE 3001

# Expose RTC ports for WebRTC (UDP)
EXPOSE 40000-40100/udp

# Expose recording RTP ports (UDP) - internal use only
EXPOSE 50000-50100/udp

# Run the server
CMD ["node", "src/server.js"]
