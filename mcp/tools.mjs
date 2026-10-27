// Logica de las herramientas, sin dependencias del SDK de MCP para poder probarla con fetch simulado.

export const SITE_URL = 'https://radarurbano.org/';
export const SUPABASE_URL = 'https://ifcgwnbaiozuvjorkcoc.supabase.co';
// Llave publicable: es la misma que usa el sitio y es publica por diseno (acceso protegido por RLS).
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Z2tMpWR9mWfzttfralmWag_Aq7xSGkB';

const AVISO =
  'Reportes de usuarios, no verificados por Radar Urbano. No implican que el titular del numero haya cometido un delito.';
const SIN_REPORTES =
  'Sin reportes no significa que sea seguro: nadie lo ha reportado todavia, pero los numeros de fraude cambian seguido.';

export class ToolError extends Error {}

/** Deja solo digitos; exige entre 8 y 15 (largo de un numero mexicano con o sin lada y clave de pais). */
export function normalizarTelefono(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new ToolError('El numero debe tener entre 8 y 15 digitos.');
  }
  return digits;
}

export async function consultarNumero(numero, { fetchImpl = fetch } = {}) {
  const phone = normalizarTelefono(numero);
  const url = `${SUPABASE_URL}/rest/v1/phone_confidence?select=report_count,last_reported_at&phone_number=eq.${phone}`;

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ToolError('No se pudo consultar Radar Urbano en este momento. Intenta de nuevo.');
  }
  if (!res.ok) throw new ToolError(`Radar Urbano respondio con un error (${res.status}).`);

  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  const count = Number(row?.report_count) || 0;

  if (count === 0) {
    return { numero: phone, reportes_unicos: 0, ultimo_reporte: null, mensaje: SIN_REPORTES, aviso: AVISO };
  }
  return {
    numero: phone,
    reportes_unicos: count,
    ultimo_reporte: row.last_reported_at ?? null,
    confianza: count >= 3 ? 'alta (3 o mas personas distintas)' : 'baja (pocas personas)',
    mensaje: count === 1 ? '1 persona reporto este numero.' : `${count} personas reportaron este numero.`,
    aviso: AVISO,
  };
}

const quitarControl = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Arma el enlace al formulario prellenado. No guarda ni envia nada: la persona usuaria lo abre,
 * lo revisa y lo envia ella.
 */
export function prepararReporte({ descripcion, telefono, zona } = {}) {
  const desc = quitarControl(String(descripcion ?? ''));
  if (desc.length < 10) throw new ToolError('La descripcion debe tener al menos 10 caracteres.');
  if (desc.length > 1000) throw new ToolError('La descripcion admite hasta 1000 caracteres.');

  const lugar = quitarControl(String(zona ?? ''));
  if (lugar.length > 200) throw new ToolError('La zona admite hasta 200 caracteres.');

  const params = new URLSearchParams({ reportar: '1' });
  let phone = null;
  if (telefono !== undefined && telefono !== null && String(telefono).trim() !== '') {
    phone = normalizarTelefono(telefono);
    params.set('telefono', phone);
  }
  if (!phone && !lugar) throw new ToolError('Indica un telefono o la zona donde ocurrio el hecho.');
  params.set('descripcion', desc);
  if (lugar) params.set('zona', lugar);

  return {
    enlace: `${SITE_URL}?${params.toString()}`,
    instrucciones:
      'Comparte este enlace con la persona usuaria. Al abrirlo vera el formulario prellenado; debe revisarlo, corregirlo y pulsar Reportar. Nada se ha enviado.',
    aviso: 'Solo reportes de hechos que la persona vivio o presencio. No lo uses para senalar a una persona por nombre.',
  };
}
