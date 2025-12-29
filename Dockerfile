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

# Install runtime dependencies for mediasoup
RUN apt-get update && apt-get install -y \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY package*.json ./
COPY src ./src

# Create directory for database
RUN mkdir -p /app/data

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/soundcast.db

# Single-tenant mode (for air-gapped deployments)
ENV SINGLE_TENANT=false
ENV ADMIN_KEY=admin

# WebRTC/mediasoup settings
ENV ANNOUNCED_IP=127.0.0.1
ENV RTC_MIN_PORT=40000
ENV RTC_MAX_PORT=40100

# Expose HTTP port
EXPOSE 3000

# Expose RTC ports for WebRTC (UDP)
EXPOSE 40000-40100/udp

# Run the server
CMD ["node", "src/server.js"]
