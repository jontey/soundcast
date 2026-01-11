# Development Guide

## Overview

This guide covers building, testing, and debugging the SoundCast transcription system, particularly the native N-API addon integration with whisper.cpp and sqlite-vec.

## Development Environment Setup

### Prerequisites

- **Node.js 22+**: Native addon compatibility
- **Python 3**: Required for node-gyp
- **CMake 3.20+**: whisper.cpp compilation
- **Build tools**: gcc/clang, make, git
- **FFmpeg**: Runtime dependency for audio conversion

### macOS Setup

```bash
# Install Xcode Command Line Tools
xcode-select --install

# Install dependencies via Homebrew
brew install cmake python@3 ffmpeg node@22

# Clone repository
git clone <your-repo-url>
cd soundcast

# Initialize submodules (whisper.cpp)
git submodule update --init --recursive

# Install Node dependencies
npm install
```

### Linux Setup (Ubuntu/Debian)

```bash
# Install build dependencies
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  cmake \
  git \
  curl \
  python3 \
  python3-pip \
  ffmpeg \
  nodejs \
  npm

# Clone repository
git clone <your-repo-url>
cd soundcast

# Initialize submodules
git submodule update --init --recursive

# Install Node dependencies
npm install
```

## Building the Native Addon

### Step 1: Build whisper.cpp

```bash
cd src/native/deps/whisper.cpp

# Configure build
cmake -B build \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=OFF \
  -DBUILD_SHARED_LIBS=OFF

# Build (use -j4 for parallel compilation)
cmake --build build --config Release -j4

# Verify build
ls build/src/libwhisper.a  # Should exist
```

### Step 2: Build Native Addon

```bash
cd ../../..  # Back to src/native
npm install  # Installs node-addon-api and runs node-gyp

# Manual rebuild if needed
npm run build

# Verify
ls build/Release/whisper_addon.node  # Should exist (~2-3MB)
```

### Step 3: Setup sqlite-vec Extension

```bash
cd ../..  # Back to project root
chmod +x scripts/setup-sqlite-vec.sh
./scripts/setup-sqlite-vec.sh

# Verify
ls lib/vec0.*  # Should show .so (Linux) or .dylib (macOS)
```

## Project Structure

```
soundcast/
├── src/
│   ├── native/                    # Native N-API addon
│   │   ├── binding.gyp            # node-gyp build config
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── whisper_addon.cc   # Main N-API entry point
│   │   │   ├── whisper_worker.cc  # Worker thread pool
│   │   │   └── audio_buffer.cc    # Lock-free ring buffer
│   │   ├── whisper-binding.js     # JavaScript wrapper
│   │   └── deps/
│   │       └── whisper.cpp/       # Git submodule
│   ├── transcription/
│   │   ├── transcriber-native.js  # Native addon integration
│   │   ├── embedder.js            # Vector embedding generation
│   │   ├── vector-store.js        # SQLite-vec queries
│   │   └── model-downloader.js    # Model download manager
│   ├── db/
│   │   ├── database.js            # SQLite initialization
│   │   └── schema.sql             # Database schema
│   └── routes/
│       └── api.js                 # API endpoints
├── scripts/
│   ├── setup-sqlite-vec.sh        # SQLite-vec installer
│   └── migrate-to-vss.js          # VSS migration script
├── test/
│   ├── phase*-test.js             # Phase-by-phase tests
│   └── phase10-integration-test.js # E2E integration test
├── docs/
│   ├── TRANSCRIPTION.md           # User documentation
│   └── DEVELOPMENT.md             # This file
├── Dockerfile                     # Multi-stage Docker build
└── docker-compose.yml             # Container orchestration
```

## Development Workflow

### 1. Make Changes to Native Code

```bash
# Edit C++ files
vim src/native/src/whisper_addon.cc

# Rebuild addon
cd src/native
npm run build

# Test changes
cd ../..
node test/phase2-native-addon-test.js
```

### 2. Make Changes to JavaScript Code

```bash
# No rebuild needed for .js files
vim src/transcription/transcriber-native.js

# Test directly
node test/phase3-native-transcription-test.js
```

### 3. Run Tests

```bash
# Phase-specific tests
node test/phase1-vss-test.js         # SQLite-vec
node test/phase2-native-addon-test.js # Native addon
node test/phase3-native-transcription-test.js # Transcription
node test/phase4-no-fallback-test.js # Fallback removal
node test/phase5-model-management-test.js # Model API

# Integration test (requires model download)
node test/phase10-integration-test.js

# Docker test
node test/phase9-docker-integration-test.js
```

### 4. Debug Native Addon

#### Using console.log

```cpp
// In whisper_addon.cc
#include <iostream>

Napi::Value WhisperSession::Transcribe(const Napi::CallbackInfo& info) {
  std::cout << "[DEBUG] Transcribe called with " << info.Length() << " args" << std::endl;
  // ... rest of function
}
```

#### Using LLDB (macOS) / GDB (Linux)

```bash
# macOS
lldb node
(lldb) run test/phase2-native-addon-test.js
(lldb) breakpoint set --file whisper_addon.cc --line 42
(lldb) continue

# Linux
gdb --args node test/phase2-native-addon-test.js
(gdb) break whisper_addon.cc:42
(gdb) run
```

#### Memory Leak Detection

```bash
# macOS (Instruments)
instruments -t Leaks node test/phase3-native-transcription-test.js

# Linux (Valgrind)
valgrind --leak-check=full --show-leak-kinds=all \
  node test/phase3-native-transcription-test.js
```

## Common Development Tasks

### Adding a New Whisper Model

```javascript
// In src/transcription/model-downloader.js
export const AVAILABLE_MODELS = {
  // ... existing models
  'large-v4': {
    name: 'large-v4',
    size: 3200,
    description: 'Latest large model (3.2GB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v4.bin',
    languages: ['multilingual']
  }
};
```

### Modifying Vector Embedding Dimensions

```sql
-- In src/db/schema.sql
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_embeddings USING vec0(
  embedding float[768]  -- Changed from 384
);
```

```javascript
// Update in src/transcription/embedder.js
const EMBEDDING_MODEL = 'Xenova/all-mpnet-base-v2'; // 768-dim model
```

### Adjusting Transcription Chunk Size

```javascript
// In src/transcription/transcriber-native.js
const CHUNK_DURATION_MS = 30000; // Change to 20000 or 60000
const SAMPLE_RATE = 16000;
const CHUNK_SIZE = (CHUNK_DURATION_MS / 1000) * SAMPLE_RATE;
```

### Changing Worker Thread Count

```javascript
// In src/native/whisper-binding.js
const DEFAULT_OPTIONS = {
  threads: 4,  // Change to 2 or 8
  language: 'en'
};
```

## Debugging Common Issues

### Issue: "Cannot find module whisper_addon.node"

**Cause**: Native addon not built

**Solution**:
```bash
cd src/native
rm -rf build node_modules
npm install
npm run build
```

### Issue: "whisper_context_init: failed to load model"

**Cause**: Model file corrupt or wrong path

**Solution**:
```bash
# Re-download model
rm models/ggml-base.en.bin
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
  -o models/ggml-base.en.bin

# Verify size (should be ~142MB for base.en)
ls -lh models/ggml-base.en.bin
```

### Issue: "Error: vec_f32() function not found"

**Cause**: sqlite-vec extension not loaded

**Solution**:
```bash
# Rebuild extension
./scripts/setup-sqlite-vec.sh

# Check database initialization
tail -f logs/server.log | grep "Vector extension loaded"
```

### Issue: Segmentation Fault in Native Addon

**Cause**: Memory corruption, buffer overflow, or null pointer

**Solution**:
```bash
# Run with core dump enabled
ulimit -c unlimited
node test/phase3-native-transcription-test.js

# Analyze core dump
lldb -c core node
(lldb) bt  # backtrace

# Add bounds checking in C++ code
if (audioBuffer.Length() < expectedSize) {
  Napi::Error::New(env, "Audio buffer too small").ThrowAsJavaScriptException();
  return env.Null();
}
```

### Issue: High Memory Usage

**Solution**:
```bash
# Monitor memory
top -pid $(pgrep -f "node.*server.js")

# Check for leaks in Node.js
node --trace-gc --trace-gc-verbose test/phase10-integration-test.js

# Reduce batch size
export EMBEDDING_BATCH_SIZE=5  # Default: 10

# Use smaller model
export WHISPER_MODEL_SIZE=tiny.en
```

## Testing

### Unit Tests

Test individual components:

```bash
# Database and VSS
node test/phase1-vss-test.js

# Native addon
node test/phase2-native-addon-test.js

# Model downloader
node test/phase5-model-management-test.js
```

### Integration Tests

Test end-to-end flow:

```bash
# Full pipeline (requires model)
node test/phase10-integration-test.js

# Docker build
node test/phase9-docker-integration-test.js
```

### Load Testing

```bash
# Create test script
cat > test/load-test.js << 'EOF'
import { WhisperTranscriber } from '../src/native/whisper-binding.js';

const MODEL_PATH = './models/ggml-tiny.en.bin';
const CONCURRENT_SESSIONS = 5;

async function loadTest() {
  const sessions = [];

  for (let i = 0; i < CONCURRENT_SESSIONS; i++) {
    const transcriber = new WhisperTranscriber(MODEL_PATH);
    await transcriber.loadModel();
    sessions.push(transcriber);
  }

  console.log(`Created ${CONCURRENT_SESSIONS} sessions`);

  // Generate test audio
  const audioBuffer = new Float32Array(16000 * 3); // 3 seconds
  for (let i = 0; i < audioBuffer.length; i++) {
    audioBuffer[i] = Math.sin(2 * Math.PI * 440 * i / 16000) * 0.1;
  }

  // Run concurrent transcriptions
  const startTime = Date.now();
  const promises = sessions.map(s => s.transcribe(audioBuffer));
  await Promise.all(promises);
  const duration = Date.now() - startTime;

  console.log(`Total time: ${duration}ms`);
  console.log(`Per session: ${(duration / CONCURRENT_SESSIONS).toFixed(0)}ms`);

  // Cleanup
  sessions.forEach(s => s.destroy());
}

loadTest().catch(console.error);
EOF

node test/load-test.js
```

## Docker Development

### Build and Test Locally

```bash
# Build image
docker build -t soundcast:dev .

# Run container
docker run -p 3000:3000 -p 3001:3001 \
  -v $(pwd)/models:/app/models \
  -e TRANSCRIPTION_ENABLED=true \
  soundcast:dev

# Inspect running container
docker exec -it <container-id> /bin/bash

# Check native addon
ls -lh /app/src/native/build/Release/whisper_addon.node

# Check sqlite-vec
ls -lh /app/lib/vec0.so
```

### Multi-Stage Build Debugging

```bash
# Build only the builder stage
docker build --target builder -t soundcast:builder .

# Inspect builder artifacts
docker run --rm soundcast:builder ls -lh /app/src/native/build/Release
docker run --rm soundcast:builder ls -lh /app/lib
```

## Performance Profiling

### CPU Profiling

```bash
# Node.js built-in profiler
node --prof test/phase10-integration-test.js
node --prof-process isolate-*.log > profile.txt
less profile.txt

# Chrome DevTools
node --inspect-brk test/phase10-integration-test.js
# Open chrome://inspect in Chrome
```

### Memory Profiling

```bash
# Heap snapshot
node --inspect test/phase10-integration-test.js
# Chrome DevTools → Memory → Take heap snapshot

# Allocation timeline
node --expose-gc --inspect test/phase10-integration-test.js
# Chrome DevTools → Memory → Allocation instrumentation on timeline
```

### Native Profiling (macOS)

```bash
# Instruments
instruments -t "Time Profiler" node test/phase3-native-transcription-test.js

# Sample
sample node -file profile.txt

# DTrace
sudo dtrace -n 'pid$target::*whisper*:entry { @[ustack()] = count(); }' \
  -p $(pgrep node)
```

## Contributing

### Code Style

- **C++**: Follow Google C++ Style Guide
- **JavaScript**: Use ESM imports, 2-space indent
- **Comments**: Explain why, not what

### Pull Request Checklist

- [ ] All phase tests pass
- [ ] Integration test passes
- [ ] Docker build succeeds
- [ ] Documentation updated
- [ ] No memory leaks (valgrind clean)
- [ ] Performance benchmarks acceptable

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**: feat, fix, docs, style, refactor, perf, test, chore

**Examples**:
```
feat(native): add streaming transcription support

Implement WhisperStream class for real-time audio processing.
Uses lock-free ring buffer for 30s audio chunks.

Closes #123

fix(embedder): handle empty transcripts gracefully

Previously crashed on zero-length text. Now returns null embedding.

perf(addon): reduce memory allocations in transcribe loop

Reuse audio buffer instead of allocating on each iteration.
Reduces GC pressure by ~50%.
```

## Architecture Deep Dive

### Native Addon Flow

```
JavaScript                    C++ (N-API)                whisper.cpp
─────────────────────────────────────────────────────────────────────
transcriber.transcribe(buf)
    │
    └──> WhisperSession::Transcribe()
             │
             ├──> Convert Napi::Buffer → float*
             │
             ├──> whisper_full()  ──────────────> Speech-to-text
             │                                     inference
             ├──> whisper_full_n_segments()
             │
             └──> Build Napi::Array
                      │
                      └────────────> segments[]
```

### Vector Search Flow

```
Query Text
    │
    ├──> embeddingService.generateEmbedding()
    │        │
    │        └──> Xenova/all-MiniLM-L6-v2 (384-dim)
    │
    ├──> Convert to Float32Array → Buffer
    │
    └──> SQLite query:
             SELECT transcript_id,
                    vec_distance_L2(embedding, vec_f32(?)) as dist
             FROM transcript_embeddings
             WHERE dist < threshold
             ORDER BY dist ASC
             LIMIT 10
```

### Memory Management

- **JavaScript**: V8 garbage collector manages transcripts, embeddings
- **Native addon**: Manual memory management for whisper_context
- **whisper.cpp**: Uses mmap for model loading (reduces memory footprint)
- **sqlite-vec**: Stores vectors in SQLite pages (memory-mapped file)

## Advanced Topics

### Custom Whisper Model Format

```bash
# Convert OpenAI Whisper checkpoint to ggml format
python3 whisper.cpp/models/convert-pt-to-ggml.py \
  /path/to/whisper-checkpoint.pt \
  /path/to/output.ggml

# Optimize for ARM (Metal)
./whisper.cpp/quantize models/ggml-medium.bin models/ggml-medium-q5_0.bin q5_0
```

### Extending N-API Addon

Add new method to WhisperSession:

```cpp
// In whisper_addon.cc
Napi::Value WhisperSession::GetModelInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!this->ctx) {
    Napi::Error::New(env, "Model not loaded").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("n_vocab", whisper_n_vocab(this->ctx));
  result.Set("n_audio_ctx", whisper_n_audio_ctx(this->ctx));
  result.Set("n_text_ctx", whisper_n_text_ctx(this->ctx));

  return result;
}

// Register in Init()
InstanceMethod("getModelInfo", &WhisperSession::GetModelInfo)
```

### Custom Vector Distance Function

```sql
-- In sqlite-vec (requires recompilation)
-- Add custom distance function (e.g., cosine similarity)
CREATE FUNCTION vec_distance_cosine(a, b) AS ...

-- Use in queries
SELECT vec_distance_cosine(embedding, ?) as similarity
FROM transcript_embeddings
```

## Resources

- [Node-API Documentation](https://nodejs.org/api/n-api.html)
- [whisper.cpp GitHub](https://github.com/ggerganov/whisper.cpp)
- [sqlite-vec Documentation](https://github.com/asg017/sqlite-vec)
- [CMake Tutorial](https://cmake.org/cmake/help/latest/guide/tutorial/)
- [Valgrind Manual](https://valgrind.org/docs/manual/)

## License

Same as SoundCast project license.
