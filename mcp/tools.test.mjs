import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultarNumero, prepararReporte, normalizarTelefono, ToolError } from './tools.mjs';

const respuesta = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('normalizarTelefono deja solo digitos y valida el largo', () => {
  assert.equal(normalizarTelefono('55 1234-5678'), '5512345678');
  assert.throws(() => normalizarTelefono('123'), ToolError);
  assert.throws(() => normalizarTelefono('1'.repeat(16)), ToolError);
});

test('consultarNumero sin reportes avisa que no significa que sea seguro', async () => {
  const r = await consultarNumero('5512345678', { fetchImpl: respuesta([]) });
  assert.equal(r.reportes_unicos, 0);
  assert.match(r.mensaje, /no significa que sea seguro/i);
});

test('consultarNumero con 3 o mas reportes marca confianza alta y siempre incluye el aviso', async () => {
  const r = await consultarNumero('5512345678', {
    fetchImpl: respuesta([{ report_count: 4, last_reported_at: '2026-10-01T00:00:00Z' }]),
  });
  assert.equal(r.reportes_unicos, 4);
  assert.match(r.confianza, /alta/);
  assert.match(r.aviso, /no verificados/i);
});

test('consultarNumero consulta solo el filtro eq del numero normalizado y manda la llave publicable', async () => {
  let visto;
  await consultarNumero('(55) 1234 5678', {
    fetchImpl: async (url, init) => {
      visto = { url, apikey: init.headers.apikey };
      return new Response('[]', { status: 200 });
    },
  });
  assert.match(visto.url, /phone_number=eq\.5512345678$/);
  assert.match(visto.apikey, /^sb_publishable_/);
});

test('consultarNumero convierte fallos de red y de la API en errores claros', async () => {
  await assert.rejects(consultarNumero('5512345678', { fetchImpl: async () => { throw new Error('red'); } }), ToolError);
  await assert.rejects(consultarNumero('5512345678', { fetchImpl: respuesta({}, 500) }), /respondio con un error/);
});

test('prepararReporte arma un enlace con parametros codificados y no envia nada', () => {
  const r = prepararReporte({ descripcion: 'Me llamaron pidiendo un deposito urgente', telefono: '55 1234 5678', zona: 'Colonia Centro' });
  const url = new URL(r.enlace);
  assert.equal(url.origin, 'https://radarurbano.org');
  assert.equal(url.searchParams.get('reportar'), '1');
  assert.equal(url.searchParams.get('telefono'), '5512345678');
  assert.equal(url.searchParams.get('descripcion'), 'Me llamaron pidiendo un deposito urgente');
  assert.match(r.instrucciones, /Nada se ha enviado/);
});

test('prepararReporte exige descripcion suficiente y telefono o zona', () => {
  assert.throws(() => prepararReporte({ descripcion: 'corto', zona: 'Centro' }), /al menos 10/);
  assert.throws(() => prepararReporte({ descripcion: 'Descripcion suficientemente larga' }), /telefono o la zona/);
  assert.throws(() => prepararReporte({ descripcion: 'x'.repeat(1001), zona: 'Centro' }), /hasta 1000/);
});

test('prepararReporte limpia caracteres de control y no deja inyectar parametros', () => {
  const r = prepararReporte({ descripcion: 'Hola\n\u0000mundo &reportar=2&x=1 completo', zona: 'Centro' });
  const url = new URL(r.enlace);
  assert.equal(url.searchParams.get('reportar'), '1');
  assert.equal(url.searchParams.get('x'), null);
  assert.equal(url.searchParams.get('descripcion'), 'Hola mundo &reportar=2&x=1 completo');
});
