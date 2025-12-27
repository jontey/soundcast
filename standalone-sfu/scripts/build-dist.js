#!/usr/bin/env node

/**
 * Build distribution packages for Soundcast SFU
 *
 * Creates self-contained distribution folders for each platform with:
 * - The compiled SFU binary
 * - The mediasoup worker binary (from bundle/mediasoup/)
 * - A wrapper script to run the SFU
 *
 * Prerequisites:
 *   npm run download-workers  # Download worker binaries first
 */

import { execSync } from 'child_process';
import { mkdirSync, cpSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const bundleDir = join(rootDir, 'bundle', 'mediasoup');

const platforms = {
  'macos-arm64': {
    target: 'node18-macos-arm64',
    binary: 'soundcast-sfu',
    workerSrc: 'mediasoup-worker-darwin-arm64',
    workerName: 'mediasoup-worker',
    wrapper: 'run.sh',
    wrapperContent: `#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export MEDIASOUP_WORKER_BIN="\${SCRIPT_DIR}/mediasoup-worker"
exec "\${SCRIPT_DIR}/soundcast-sfu" "$@"
`
  },
  linux: {
    target: 'node18-linux-x64',
    binary: 'soundcast-sfu',
    workerSrc: 'mediasoup-worker-linux-x64',
    workerName: 'mediasoup-worker',
    wrapper: 'run.sh',
    wrapperContent: `#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export MEDIASOUP_WORKER_BIN="\${SCRIPT_DIR}/mediasoup-worker"
exec "\${SCRIPT_DIR}/soundcast-sfu" "$@"
`
  },
  'linux-arm64': {
    target: 'node18-linux-arm64',
    binary: 'soundcast-sfu',
    workerSrc: 'mediasoup-worker-linux-arm64',
    workerName: 'mediasoup-worker',
    wrapper: 'run.sh',
    wrapperContent: `#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export MEDIASOUP_WORKER_BIN="\${SCRIPT_DIR}/mediasoup-worker"
exec "\${SCRIPT_DIR}/soundcast-sfu" "$@"
`
  },
  windows: {
    target: 'node18-win-x64',
    binary: 'soundcast-sfu.exe',
    workerSrc: 'mediasoup-worker-win32-x64.exe',
    workerName: 'mediasoup-worker.exe',
    wrapper: 'run.bat',
    wrapperContent: `@echo off
set SCRIPT_DIR=%~dp0
set MEDIASOUP_WORKER_BIN=%SCRIPT_DIR%mediasoup-worker.exe
"%SCRIPT_DIR%soundcast-sfu.exe" %*
`
  }
};


function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: rootDir, ...opts });
}

function buildPlatform(name, config) {
  console.log(`\n📦 Building ${name}...`);

  const platformDir = join(distDir, name);

  // Create platform directory
  mkdirSync(platformDir, { recursive: true });

  // Build binary with pkg
  run(`npx pkg dist/sfu-server.cjs --target ${config.target} --output ${platformDir}/${config.binary}`);

  // Copy mediasoup worker from bundle directory
  const workerSrc = join(bundleDir, config.workerSrc);
  const workerDest = join(platformDir, config.workerName);

  if (existsSync(workerSrc)) {
    cpSync(workerSrc, workerDest);
    console.log(`✅ Copied mediasoup worker from bundle/`);
  } else {
    console.error(`❌ mediasoup worker not found at ${workerSrc}`);
    console.error(`   Run 'npm run download-workers' first to download worker binaries`);
    process.exit(1);
  }

  // Create wrapper script
  const wrapperPath = join(platformDir, config.wrapper);
  writeFileSync(wrapperPath, config.wrapperContent);

  // Make executable on Unix
  if (!name.includes('windows')) {
    chmodSync(wrapperPath, '755');
    chmodSync(join(platformDir, config.binary), '755');
    chmodSync(workerDest, '755');
  }

  console.log(`✅ ${name} distribution ready at dist/${name}/`);
}

async function main() {
  console.log('🚀 Building Soundcast SFU distributions\n');

  // Check if bundle directory exists
  if (!existsSync(bundleDir)) {
    console.error('❌ Worker binaries not found in bundle/mediasoup/');
    console.error('   Run: npm run download-workers');
    process.exit(1);
  }

  // Step 1: Bundle with esbuild
  console.log('📦 Bundling with esbuild...');
  run('npm run bundle');

  // Step 2: Build each platform
  const targetPlatform = process.argv[2];

  if (targetPlatform && platforms[targetPlatform]) {
    buildPlatform(targetPlatform, platforms[targetPlatform]);
  } else if (targetPlatform) {
    console.error(`Unknown platform: ${targetPlatform}`);
    console.log('Available: macos-arm64, linux, linux-arm64, windows');
    process.exit(1);
  } else {
    // Build all platforms
    for (const [name, config] of Object.entries(platforms)) {
      buildPlatform(name, config);
    }
  }

  console.log('\n✅ Build complete!');
  console.log('\n📝 Usage:');
  console.log('   cd dist/<platform>');
  console.log('   ./run.sh --url https://soundcast.example.com --key YOUR_KEY\n');
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
