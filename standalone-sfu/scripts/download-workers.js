#!/usr/bin/env node

/**
 * Download mediasoup worker binaries from GitHub releases
 *
 * Downloads pre-built worker binaries for all supported platforms
 * and extracts them to bundle/mediasoup/
 */

import { createWriteStream, mkdirSync, existsSync, renameSync, chmodSync, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bundleDir = join(rootDir, 'bundle', 'mediasoup');

const MEDIASOUP_VERSION = '3.19.14';
const GITHUB_RELEASE_URL = `https://github.com/versatica/mediasoup/releases/download/${MEDIASOUP_VERSION}`;

const workers = [
  {
    name: 'darwin-arm64',
    file: `mediasoup-worker-${MEDIASOUP_VERSION}-darwin-arm64.tgz`,
    outputName: 'mediasoup-worker-darwin-arm64'
  },
  {
    name: 'linux-x64',
    file: `mediasoup-worker-${MEDIASOUP_VERSION}-linux-x64-kernel6.tgz`,
    outputName: 'mediasoup-worker-linux-x64'
  },
  {
    name: 'linux-arm64',
    file: `mediasoup-worker-${MEDIASOUP_VERSION}-linux-arm64-kernel6.tgz`,
    outputName: 'mediasoup-worker-linux-arm64'
  },
  {
    name: 'win32-x64',
    file: `mediasoup-worker-${MEDIASOUP_VERSION}-win32-x64.tgz`,
    outputName: 'mediasoup-worker-win32-x64.exe'
  }
];

async function downloadFile(url, destPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const fileStream = createWriteStream(destPath);
  await pipeline(response.body, fileStream);
}

function extractTgz(tgzPath, destDir) {
  // Use system tar command
  execSync(`tar -xzf "${tgzPath}" -C "${destDir}"`, { stdio: 'pipe' });
}

async function downloadWorker(worker) {
  const url = `${GITHUB_RELEASE_URL}/${worker.file}`;
  const tgzPath = join(bundleDir, worker.file);
  const outputPath = join(bundleDir, worker.outputName);

  // Skip if already exists
  if (existsSync(outputPath)) {
    console.log(`  ✓ ${worker.name} already exists, skipping`);
    return;
  }

  console.log(`  ↓ Downloading ${worker.name}...`);
  await downloadFile(url, tgzPath);

  console.log(`  ↓ Extracting ${worker.name}...`);
  extractTgz(tgzPath, bundleDir);

  // The extracted file is named 'mediasoup-worker' (or 'mediasoup-worker.exe' on Windows)
  let extractedPath = join(bundleDir, 'mediasoup-worker');
  if (!existsSync(extractedPath)) {
    extractedPath = join(bundleDir, 'mediasoup-worker.exe');
  }
  if (existsSync(extractedPath)) {
    renameSync(extractedPath, outputPath);
    // Make executable on Unix
    if (!worker.name.includes('win32')) {
      chmodSync(outputPath, '755');
    }
  } else {
    console.error(`  ✗ Extracted file not found for ${worker.name}`);
  }

  // Clean up tgz
  unlinkSync(tgzPath);

  console.log(`  ✓ ${worker.name} ready`);
}

async function main() {
  console.log(`\n📦 Downloading mediasoup ${MEDIASOUP_VERSION} worker binaries\n`);

  // Create bundle directory
  mkdirSync(bundleDir, { recursive: true });

  // Download all workers
  for (const worker of workers) {
    try {
      await downloadWorker(worker);
    } catch (error) {
      console.error(`  ✗ Failed to download ${worker.name}: ${error.message}`);
    }
  }

  console.log('\n✅ Done!\n');
  console.log('Workers saved to: bundle/mediasoup/\n');
}

main().catch(err => {
  console.error('Download failed:', err);
  process.exit(1);
});
