#!/usr/bin/env python3
"""Valida sitemap.xml: XML bien formado, URLs del dominio y archivo local existente."""
import os
import sys
import xml.etree.ElementTree as ET

NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
BASE = "https://radarurbano.org/"

tree = ET.parse("sitemap.xml")
locs = [e.text.strip() for e in tree.getroot().findall("s:url/s:loc", NS)]
if not locs:
    sys.exit("sitemap.xml sin URLs")

bad = 0
for loc in locs:
    if not loc.startswith(BASE):
        print(f"URL fuera del dominio: {loc}")
        bad += 1
        continue
    path = loc[len(BASE):] or "index.html"
    if not os.path.isfile(path):
        print(f"No existe el archivo para {loc}: {path}")
        bad += 1

if f"Sitemap: {BASE}sitemap.xml" not in open("robots.txt", encoding="utf-8").read():
    print("robots.txt no referencia el sitemap")
    bad += 1

sys.exit(1 if bad else 0)
