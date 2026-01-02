#!/bin/bash

# Generate self-signed TLS certificate for soundcast
# This script creates a certificate valid for 365 days

CERT_DIR="${1:-./certs}"
DAYS="${2:-365}"

mkdir -p "$CERT_DIR"

# Generate private key and self-signed certificate
openssl req -x509 -nodes -days "$DAYS" \
    -newkey rsa:2048 \
    -keyout "$CERT_DIR/server.key" \
    -out "$CERT_DIR/server.crt" \
    -subj "/C=US/ST=Local/L=Local/O=Soundcast/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:*.local,IP:127.0.0.1,IP:0.0.0.0"

chmod 600 "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/server.crt"

echo "TLS certificates generated in $CERT_DIR"
echo "  Key:  $CERT_DIR/server.key"
echo "  Cert: $CERT_DIR/server.crt"
