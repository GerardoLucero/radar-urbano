#!/usr/bin/env bash
# Uso: probe.sh <url> [archivo_salida]
# Sale 0 si responde 2xx. Un 403 con cabecera cf-mitigated (reto de Cloudflare a IPs de
# datacenter) se trata como inconcluso: avisa y sale 0, porque no indica que el sitio este caido.
set -u
url=$1; out=${2:-/dev/null}
hdr=$(mktemp)
code=$(curl -sS -L --max-time 20 -D "$hdr" -o "$out" -w '%{http_code}' "$url") || { echo "curl fallo: $url" >&2; exit 1; }
if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then exit 0; fi
if [ "$code" = 403 ] && grep -qi '^cf-mitigated:' "$hdr"; then
  echo "::warning::Cloudflare reto a este runner (403) en $url; chequeo inconcluso. Crear regla WAF Skip para el runner o cabecera secreta (ver RUNBOOK)."
  exit 0
fi
echo "HTTP $code en $url" >&2; exit 1
