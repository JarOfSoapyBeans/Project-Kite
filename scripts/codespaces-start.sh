#!/usr/bin/env bash
# Starts the Kite backend (port 8080) and frontend (port 3000) inside a GitHub
# Codespace, wired together using the Codespace's forwarded-port URLs.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CODESPACE_NAME:?Run this inside a GitHub Codespace}"
DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"

FRONT_URL="https://${CODESPACE_NAME}-3000.${DOMAIN}"
BACK_URL="https://${CODESPACE_NAME}-8080.${DOMAIN}"

echo "Frontend: ${FRONT_URL}"
echo "Backend:  ${BACK_URL}"

# Backend: only accept requests that come from this Codespace's frontend.
(cd backend && ALLOWED_ORIGINS="${FRONT_URL}" PORT=8080 node server.js) &
BACKEND_PID=$!
trap 'kill ${BACKEND_PID} 2>/dev/null || true' EXIT

# Frontend: write the backend URL into config.js, then serve on 3000.
(cd frontend && BACKEND_URL="${BACK_URL}" npm run dev) &
FRONTEND_PID=$!

# Codespaces ports are private by default, which blocks the browser's requests to
# the backend. Make both public.
sleep 6
gh codespace ports visibility 3000:public 8080:public -c "${CODESPACE_NAME}" \
  || echo "Could not set ports public automatically. Do it in the Ports tab (right-click > Port Visibility > Public)."

echo
echo "Open: ${FRONT_URL}"
wait ${FRONTEND_PID}
