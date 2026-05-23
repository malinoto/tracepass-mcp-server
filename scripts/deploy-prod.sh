#!/usr/bin/env bash
#
# Deploy the TracePass MCP server to the production VPS (tracepass-prod).
#
# What it does:
#   1. rsync this repo to /opt/tracepass-mcp-server on the VPS.
#   2. SSH in and run `docker compose -f docker-compose.production.yml
#      up -d --build`. Build is fast — single TypeScript service, no
#      next.js, no webpack — usually under 30 seconds with warm caches.
#   3. Stream container status.
#   4. Health-check the public endpoint at https://ai.tracepass.eu/mcp.
#
# Run from your laptop (project root):
#   ./scripts/deploy-prod.sh
#
# Prerequisites:
#   - tracepass-platform stack must already be running on the box
#     (this compose file references the `tracepass` docker network as
#     external; the platform owns it). Deploy the platform stack
#     first if this is a fresh box.
#   - DNS for ai.tracepass.eu must point at the prod VPS — Caddy
#     auto-provisions the Let's Encrypt cert on first request.
#
# Idempotent: safe to re-run. Compose only restarts services whose
# images or config changed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VPS_ALIAS="${VPS_ALIAS:-tracepass-prod}"
REMOTE_PATH="/opt/tracepass-mcp-server"
CONTAINER="tracepass-mcp"

echo "=== 1/4 syncing repo to ${VPS_ALIAS}:${REMOTE_PATH} ==="
rsync -azv --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='*.tsbuildinfo' \
  --exclude='.DS_Store' \
  "${REPO_ROOT}/" \
  "${VPS_ALIAS}:${REMOTE_PATH}/"

echo ""
echo "=== 2/4 building + starting the MCP service on ${VPS_ALIAS} ==="
ssh "${VPS_ALIAS}" "cd ${REMOTE_PATH} && \
  docker compose -f docker-compose.production.yml up -d --build"

echo ""
echo "=== 3/4 status ==="
ssh "${VPS_ALIAS}" "cd ${REMOTE_PATH} && \
  docker compose -f docker-compose.production.yml ps"

echo ""
echo "=== 4/4 health check ==="
# The MCP server only accepts POST on /mcp; a GET should be rejected
# but with a structured 400, not a connection-refused. That's enough
# to prove the container is up + Caddy reverse-proxy is working.
echo "Probing https://ai.tracepass.eu/mcp ..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://ai.tracepass.eu/mcp || echo "000")
case "${HTTP_CODE}" in
  4*) echo "  ✓ HTTP ${HTTP_CODE} — MCP service is up (rejecting GET as expected)" ;;
  2*) echo "  ✓ HTTP ${HTTP_CODE} — MCP service is up" ;;
  000) echo "  ✗ connection failed — DNS may not be resolving yet, or cert isn't ready" ;;
  *)   echo "  ⚠ HTTP ${HTTP_CODE} — unexpected; check 'docker logs tracepass-mcp'" ;;
esac

echo ""
echo "=== deploy complete ==="
echo "Tail logs with:  ssh ${VPS_ALIAS} 'cd ${REMOTE_PATH} && docker compose -f docker-compose.production.yml logs -f mcp'"
