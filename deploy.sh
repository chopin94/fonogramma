#!/usr/bin/env bash
# Copia Fonogramma sul PC di casa e lo avvia con Docker in /home/fonogramma.
# Uso (da Git Bash su Windows):  ./deploy.sh utente@host
set -euo pipefail
HOST="${1:-${FONOGRAMMA_HOST:-}}"
[ -n "$HOST" ] || { echo "Uso: ./deploy.sh utente@host   (oppure imposta FONOGRAMMA_HOST)"; exit 1; }
DEST=/home/fonogramma
SITE_HOST="${HOST#*@}"
cd "$(dirname "$0")"

echo "> Preparo ${DEST} su ${HOST}"
ssh -t "$HOST" "sudo mkdir -p ${DEST} && sudo chown \$(id -u):\$(id -g) ${DEST}"

echo "> Copio i file"
tar -czf - docker-compose.yml Caddyfile install.sh server/Dockerfile server/requirements.txt server/main.py web README.md \
  | ssh "$HOST" "tar -xzf - -C ${DEST} && chmod +x ${DEST}/install.sh"

echo "> Avvio i container"
ssh -t "$HOST" "cd ${DEST} && SITE_HOST=${SITE_HOST} ./install.sh"
