#!/bin/bash
#
# Transcription Setup Script
# Sets up Whisper.cpp, downloads models, and configures transcription dependencies
#

set -e  # Exit on error

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🎙️  Soundcast Transcription Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check for required tools
command -v git >/dev/null 2>&1 || { echo "❌ Error: git is required but not installed. Aborting." >&2; exit 1; }
command -v make >/dev/null 2>&1 || { echo "❌ Error: make is required but not installed. Aborting." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "❌ Error: curl is required but not installed. Aborting." >&2; exit 1; }

echo "✅ Prerequisites check passed"
echo ""

# 1. Clone and build whisper.cpp
echo "──────────────────────────────────────────────────"
echo "📦 Step 1: Setting up whisper.cpp"
echo "──────────────────────────────────────────────────"

if [ -d "whisper.cpp" ]; then
  echo "⚠️  whisper.cpp directory already exists"
  read -p "Do you want to rebuild? (y/N): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🔄 Rebuilding whisper.cpp..."
    cd whisper.cpp
    git pull origin master
    make clean
    make server
    cd ..
  else
    echo "⏭️  Skipping whisper.cpp build"
  fi
else
  echo "📥 Cloning whisper.cpp repository..."
  git clone https://github.com/ggerganov/whisper.cpp.git

  echo "🔨 Building whisper.cpp server..."
  cd whisper.cpp
  make server
  cd ..
fi

# Verify server binary exists
if [ ! -f "whisper.cpp/server" ]; then
  echo "❌ Error: whisper.cpp server binary not found" >&2
  exit 1
fi

echo "✅ Whisper.cpp server built successfully"
echo ""

# 2. Create models directory
echo "──────────────────────────────────────────────────"
echo "📁 Step 2: Creating models directory"
echo "──────────────────────────────────────────────────"

mkdir -p models
echo "✅ Models directory created"
echo ""

# 3. Download Whisper models
echo "──────────────────────────────────────────────────"
echo "📥 Step 3: Downloading Whisper models"
echo "──────────────────────────────────────────────────"
echo ""
echo "Available models:"
echo "  • tiny    (75 MB)  - Fastest, lowest accuracy"
echo "  • base    (142 MB) - Good balance (RECOMMENDED)"
echo "  • small   (466 MB) - Better accuracy, slower"
echo "  • medium  (1.5 GB) - High accuracy, slow"
echo "  • large   (2.9 GB) - Highest accuracy, very slow"
echo ""

# Default to base model
MODEL_SIZE="${1:-base}"
echo "Downloading model: $MODEL_SIZE"
echo ""

download_model() {
  local size=$1
  local url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$size.bin"
  local output="models/ggml-$size.bin"

  if [ -f "$output" ]; then
    echo "⚠️  Model already exists: $output"
    return 0
  fi

  echo "📥 Downloading $size model..."
  curl -L --progress-bar "$url" -o "$output"

  if [ $? -eq 0 ]; then
    echo "✅ Downloaded: $output ($(du -h "$output" | cut -f1))"
    return 0
  else
    echo "❌ Failed to download $size model" >&2
    return 1
  fi
}

# Download the specified model
download_model "$MODEL_SIZE"

# Optionally download English-only variant (smaller, faster for English)
read -p "Download English-only variant? (faster for English broadcasts) (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  download_model "$MODEL_SIZE.en"
fi

echo ""
echo "──────────────────────────────────────────────────"
echo "📋 Step 4: Verifying installation"
echo "──────────────────────────────────────────────────"

# Verify whisper.cpp server
WHISPER_VERSION=$(./whisper.cpp/server --version 2>&1 | head -n 1 || echo "unknown")
echo "✅ Whisper.cpp version: $WHISPER_VERSION"

# Count downloaded models
MODEL_COUNT=$(ls -1 models/*.bin 2>/dev/null | wc -l | tr -d ' ')
echo "✅ Downloaded models: $MODEL_COUNT"

# List models
if [ $MODEL_COUNT -gt 0 ]; then
  echo ""
  echo "   Available models:"
  ls -lh models/*.bin | awk '{print "   •", $9, "(" $5 ")"}'
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Transcription setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "  1. Update your .env file with:"
echo "     TRANSCRIPTION_ENABLED=true"
echo "     WHISPER_CPP_PATH=./whisper.cpp/server"
echo "     WHISPER_MODEL_DIR=./models"
echo "     WHISPER_MODEL_SIZE=$MODEL_SIZE"
echo ""
echo "  2. Install npm dependencies:"
echo "     npm install"
echo ""
echo "  3. Start the server:"
echo "     npm start"
echo ""
