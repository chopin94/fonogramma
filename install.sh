#!/usr/bin/env bash
# Installa / aggiorna Fonogramma con Docker. Va eseguito dentro /home/fonogramma.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null 2>&1 || { echo "ERRORE: Docker non è installato su questo PC."; exit 1; }
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi
$DOCKER compose version >/dev/null 2>&1 || { echo "ERRORE: manca il plugin 'docker compose'."; exit 1; }

port_busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }
lan_ip() { ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}'; }

if [ ! -f .env ]; then
  HOST_IP="${SITE_HOST:-$(lan_ip)}"
  HOST_IP="${HOST_IP:-$(hostname -I | awk '{print $1}')}"
  HTTP_PORT=80;  port_busy 80  && HTTP_PORT=8080
  HTTPS_PORT=443; port_busy 443 && HTTPS_PORT=8443
  PIN=$(printf "%06d" $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 )))
  cat > .env <<EOF
SITE_HOST=${HOST_IP}
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}
ACCESS_PIN=${PIN}
PUID=$(id -u)
PGID=$(id -g)
EOF
  echo "Creato .env (host ${HOST_IP}, porte ${HTTP_PORT}/${HTTPS_PORT})."
fi

# indirizzi serviti: rete di casa + Tailscale (se presente) + localhost
set_env() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
SITE_HOST_CUR=$(grep '^SITE_HOST=' .env | cut -d= -f2)
TS_HOST="${TS_HOST:-$(tailscale ip -4 2>/dev/null | head -1)}"
grep -q '^APP_PORT=' .env || set_env APP_PORT 8001
ADDRS="https://${SITE_HOST_CUR}"
[ -n "$TS_HOST" ] && [ "$TS_HOST" != "$SITE_HOST_CUR" ] && ADDRS="${ADDRS}, https://${TS_HOST}"
set_env TS_HOST "${TS_HOST}"
TS_NAME="${TS_NAME:-$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print((json.load(sys.stdin).get("CertDomains") or [""])[0])' 2>/dev/null)}"
set_env TS_NAME "${TS_NAME}"
[ -n "$TS_NAME" ] && set_env PUBLIC_ADDRS "https://${TS_NAME}"
set_env SITE_ADDRS "\"${ADDRS}, https://localhost\""

# versione del service worker = impronta dei file web: i dispositivi si aggiornano da soli
HASH=$(find web -type f ! -name sw.js -exec md5sum {} + | sort -k2 | md5sum | cut -c1-10)
sed -i "s/^const VERSION = .*/const VERSION = 'fonogramma-${HASH}';/" web/sw.js

mkdir -p data caddy_data caddy_config
$DOCKER compose up -d --build --remove-orphans

for _ in $(seq 1 40); do
  $DOCKER compose exec -T caddy test -f /data/caddy/pki/authorities/local/root.crt 2>/dev/null && break
  sleep 1
done

set -a; . ./.env; set +a
PORT_SUFFIX=""; [ "${HTTPS_PORT}" != "443" ] && PORT_SUFFIX=":${HTTPS_PORT}"
HTTP_SUFFIX="";  [ "${HTTP_PORT}" != "80" ] && HTTP_SUFFIX=":${HTTP_PORT}"
echo
echo "================ FONOGRAMMA ATTIVO ================"
echo " App (HTTPS):      https://${SITE_HOST}${PORT_SUFFIX}/"
[ -n "${TS_NAME:-}" ] && echo " Tailscale (consigliato, certificato valido): https://${TS_NAME}${PORT_SUFFIX}/"
[ -n "${TS_HOST:-}" ] && echo " Tailscale (IP):   https://${TS_HOST}${PORT_SUFFIX}/"
echo " Certificato CA:   http://${SITE_HOST}${HTTP_SUFFIX}/ca.crt"
echo " PIN di accesso:   ${ACCESS_PIN:-(nessuno)}"
echo " Versione web:     ${HASH}"
echo " Dati:             $(pwd)/data"
echo "==================================================="
