# Build stage
FROM node:22-bookworm AS builder

# Install build dependencies (mediasoup + whisper.cpp + native addon)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    cmake \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including native dependencies)
RUN npm ci --only=production

# Copy native addon source
COPY src/native ./src/native

# Build whisper.cpp
WORKDIR /app/src/native/deps/whisper.cpp
RUN test -f CMakeLists.txt || (echo "whisper.cpp submodule not present. Run: git submodule update --init --recursive" && exit 1) && \
    rm -rf build && \
    cmake -B build -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON && \
    cmake --build build --config Release -j4

# Build native addon
WORKDIR /app/src/native
RUN npm install && npm run build

# Build sqlite-vec extension
WORKDIR /app
COPY scripts/setup-sqlite-vec.sh ./scripts/
RUN chmod +x scripts/setup-sqlite-vec.sh && ./scripts/setup-sqlite-vec.sh

# Production stage
FROM node:22-bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    openssl \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy built native addon
COPY --from=builder /app/src/native/build ./src/native/build
COPY --from=builder /app/src/native/node_modules ./src/native/node_modules
COPY --from=builder /app/src/native/package.json ./src/native/

# Copy built sqlite-vec extension
COPY --from=builder /app/lib ./lib

# Copy application source
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts
COPY certs ./certs

# Create directories
RUN mkdir -p /app/data /app/certs /app/recordings /app/models

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

# Transcription settings
ENV TRANSCRIPTION_ENABLED=true
ENV TRANSCRIPTION_USE_NATIVE=true
ENV WHISPER_MODEL_DIR=/app/models
ENV WHISPER_MODEL_SIZE=base
ENV TRANSCRIPTION_RTP_PORT_MIN=51000
ENV TRANSCRIPTION_RTP_PORT_MAX=51999

# Embedding settings
ENV EMBEDDING_ENABLED=true

# SQLite-vec extension path
ENV SQLITE_VEC_PATH=/app/lib/vec0.so

# Expose HTTP port
EXPOSE 3000

# Expose HTTPS port
EXPOSE 3001

# Expose RTC ports for WebRTC (UDP)
EXPOSE 40000-40100/udp

# Expose recording RTP ports (UDP) - internal use only
EXPOSE 50000-50100/udp

# Expose transcription RTP ports (UDP) - internal use only
EXPOSE 51000-51999/udp

# Run the server
CMD ["node", "src/server.js"]
