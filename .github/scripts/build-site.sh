#!/usr/bin/env bash
# Arma _site/ con SOLO lo que debe publicarse. Falla si falta algo requerido.
set -euo pipefail
rm -rf _site
mkdir -p _site
for f in index.html CNAME privacidad.html terminos.html arco.html sitemap.xml robots.txt; do
  [ -f "$f" ] || { echo "Falta archivo requerido: $f" >&2; exit 1; }
  cp "$f" _site/
done
# Carpetas de assets estaticos, solo si existen
for d in assets img images static; do
  if [ -d "$d" ]; then cp -R "$d" "_site/$d"; fi
done
touch _site/.nojekyll
echo "Contenido de _site:"
find _site -type f | sort
