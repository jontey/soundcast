#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../asr-sidecar"
exec ./start.sh
