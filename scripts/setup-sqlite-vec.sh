#!/bin/bash
set -e

# SQLite-vec Extension Setup Script
# Builds the sqlite-vec extension for vector similarity search

SQLITE_VEC_VERSION="0.1.1"
BUILD_DIR="./build/sqlite-vec"
INSTALL_DIR="./lib"

echo "🔧 Building sqlite-vec extension..."

# Create directories
mkdir -p "$BUILD_DIR" "$INSTALL_DIR"
cd "$BUILD_DIR"

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    if [[ $(uname -m) == "arm64" ]]; then
        PLATFORM="macos-aarch64"
        EXT_NAME="vec0.dylib"
    else
        PLATFORM="macos-x86_64"
        EXT_NAME="vec0.dylib"
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if [[ $(uname -m) == "aarch64" ]]; then
        PLATFORM="linux-aarch64"
        EXT_NAME="vec0.so"
    else
        PLATFORM="linux-x86_64"
        EXT_NAME="vec0.so"
    fi
else
    echo "❌ Unsupported platform: $OSTYPE"
    exit 1
fi

echo "📦 Platform detected: $PLATFORM"

# Download pre-compiled extension directly
DOWNLOAD_URL="https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/sqlite-vec-${SQLITE_VEC_VERSION}-loadable-${PLATFORM}.tar.gz"

echo "📥 Downloading from: $DOWNLOAD_URL"
curl -L "$DOWNLOAD_URL" -o sqlite-vec.tar.gz

# Check if download was successful
if [ ! -f sqlite-vec.tar.gz ] || [ ! -s sqlite-vec.tar.gz ]; then
    echo "❌ Download failed"
    echo "URL: $DOWNLOAD_URL"
    exit 1
fi

# Extract
echo "📦 Extracting archive..."
tar -xzf sqlite-vec.tar.gz

# Find the extension file
FOUND_FILE=$(find . -name "vec0.*" -type f | head -n 1)

if [ -z "$FOUND_FILE" ]; then
    echo "❌ Extension file not found after extraction"
    echo "Contents of archive:"
    ls -R
    exit 1
fi

echo "✅ Found extension: $FOUND_FILE"

# Copy to install directory
cp "$FOUND_FILE" "../../${INSTALL_DIR}/${EXT_NAME}"

# Return to root
cd ../..

# Verify installation
if [ -f "${INSTALL_DIR}/${EXT_NAME}" ]; then
    echo "✅ sqlite-vec installed to ${INSTALL_DIR}/${EXT_NAME}"
    echo ""
    echo "Extension size: $(du -h ${INSTALL_DIR}/${EXT_NAME} | cut -f1)"
    echo ""
    echo "To use in Node.js:"
    echo "  db.loadExtension('./${INSTALL_DIR}/${EXT_NAME}');"
else
    echo "❌ Installation failed"
    exit 1
fi

echo "🎉 Setup complete!"
