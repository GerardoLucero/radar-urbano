// Utilidades para tratar texto de usuarios como DATO no confiable antes de
// mandarlo a un modelo, y para limpiar lo que el modelo devuelve.

const URL_RE = /\b(?:https?|ftp|file|data|javascript):[^\s<>"']*|\bwww\.[^\s<>"']+/gi
// dominio.tld/ruta sin esquema (p. ej. bit.ly/abc, evil.com/x)
const BARE_DOMAIN_RE =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|mx|ly|co|me|gl|app|dev|xyz|info|biz|ru|cn|tk|link|click|top)\b(?:\/[^\s<>"']*)?/gi
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩﻿]/g

/** Texto de usuario listo para ir dentro de etiquetas <reporte>: sin URLs, sin etiquetas, truncado. */
export function sanitizeUserText(input: unknown, maxLen = 500): string {
  let s = typeof input === 'string' ? input : ''
  s = s.normalize('NFKC').replace(CONTROL_RE, ' ')
  s = s.replace(URL_RE, '[enlace]').replace(BARE_DOMAIN_RE, '[enlace]')
  // Neutraliza cualquier etiqueta (incluidas </reporte> y variantes con espacios o mayusculas).
  s = s.replace(/</g, '‹').replace(/>/g, '›')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd() + '...'
  return s
}

/** Valor corto tipo etiqueta (categoria, id) para incrustar en el prompt. */
export function sanitizeToken(input: unknown, maxLen = 40): string {
  const s = typeof input === 'string' ? input : ''
  return s.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, maxLen)
}

/** Limpia texto generado por el modelo antes de mostrarlo: sin HTML, sin URLs, longitud acotada. */
export function sanitizeModelText(input: unknown, maxLen = 700): string {
  let s = typeof input === 'string' ? input : ''
  s = s.normalize('NFKC').replace(CONTROL_RE, ' ')
  s = s.replace(/<[^>]*>?/g, ' ') // etiquetas completas o truncadas
  s = s.replace(URL_RE, '').replace(BARE_DOMAIN_RE, '')
  s = s.replace(/[<>]/g, '')
  s = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim()
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd() + '...'
  return s
}
