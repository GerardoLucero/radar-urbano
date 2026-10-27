// Radar Urbano -- logica de la pagina. Se carga como modulo desde index.html.
// Las librerias (supabase-js, leaflet, leaflet.heat) se cargan dinamicamente para
// poder mostrar un error visible con boton Reintentar si el CDN falla.

const SUPABASE_URL = 'https://ifcgwnbaiozuvjorkcoc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Z2tMpWR9mWfzttfralmWag_Aq7xSGkB';
const SITE_URL = 'https://radarurbano.org/';

const SUPABASE_JS_URL = 'https://esm.sh/@supabase/supabase-js@2.117.2';
const LEAFLET_URL = 'https://esm.sh/leaflet@1.9.4';
const LEAFLET_HEAT_URL = 'https://esm.sh/leaflet.heat@0.2.0?deps=leaflet@1.9.4';

const $ = (id) => document.getElementById(id);

// Escapa cualquier dato que termine en innerHTML, atributos o popups de Leaflet.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => (n === 1 ? one : many);
const fmtDate = (d) => new Date(d).toLocaleDateString('es-MX');
const normalizePhone = (raw) => raw.replace(/\D/g, '');

// ---- Cache en localStorage con TTL (todo en try/catch: puede estar bloqueado) ----
const CACHE_PREFIX = 'ru:v1:';
function cacheGet(key, ttlMs) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (typeof t !== 'number' || Date.now() - t > ttlMs) return null;
    return v;
  } catch {
    return null;
  }
}
function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    /* sin cache: no pasa nada */
  }
}
const SESNSP_TTL = 24 * 60 * 60 * 1000;
const LADA_TTL = 60 * 60 * 1000;

// ---- Dialogos accesibles (<dialog> + showModal: Escape, foco atrapado y retorno de foco) ----
function setupDialog(dialog, onClose) {
  let opener = null;
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
    if (onClose) onClose();
  });
  return {
    open(focusEl) {
      opener = document.activeElement;
      if (!dialog.open) dialog.showModal();
      if (focusEl) setTimeout(() => focusEl.focus(), 50);
    },
    close() { if (dialog.open) dialog.close(); },
  };
}

function setPressed(btn, on) {
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// ---- Compartir ----
function setupShare() {
  const btn = $('share-btn');
  const text = 'Radar Urbano: reporta y consulta fraudes, robos y asaltos cerca de ti.';
  btn.addEventListener('click', async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Radar Urbano', text, url: SITE_URL });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${SITE_URL}`)}`, '_blank', 'noopener');
  });
}

function showBootError() {
  const el = $('boot-error');
  el.hidden = false;
  $('boot-retry').addEventListener('click', () => location.reload());
  $('boot-retry').focus();
}

async function boot() {
  let createClient;
  try {
    ({ createClient } = await import(SUPABASE_JS_URL));
    await import(LEAFLET_URL);
    if (!window.L) throw new Error('leaflet no disponible');
  } catch (err) {
    console.error('No se pudieron cargar las librerias', err);
    showBootError();
    return;
  }
  // leaflet.heat es opcional: sin el, el mapa funciona y solo se desactiva el calor.
  let heatAvailable = true;
  try {
    await import(LEAFLET_HEAT_URL);
    if (!window.L.heatLayer) heatAvailable = false;
  } catch (err) {
    console.warn('leaflet.heat no cargo', err);
    heatAvailable = false;
  }
  start(createClient, heatAvailable);
}

function start(createClient, heatAvailable) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  const L = window.L;

  // Datos cargados que tambien usa la busqueda (region LADA).
  let allLada = [];

  // =====================================================================
  // Busqueda (panel bajo demanda)
  // =====================================================================
  const searchInput = $('search-input');
  const searchBtn = $('search-btn');
  const searchResults = $('search-results');
  const searchDialog = $('search-overlay');
  const searchTitle = $('search-title');
  const searchIntro = $('search-intro');
  const searchModePhoneBtn = $('search-mode-phone');
  const searchModeNameBtn = $('search-mode-name');
  const searchSheet = setupDialog(searchDialog);

  let searchMode = 'phone'; // 'phone' | 'name'

  function setSearchMode(mode) {
    searchMode = mode;
    searchResults.innerHTML = '';
    searchInput.value = '';
    setPressed(searchModePhoneBtn, mode === 'phone');
    setPressed(searchModeNameBtn, mode === 'name');
    if (mode === 'phone') {
      searchTitle.textContent = 'Buscar un número';
      searchIntro.textContent = 'Consulta si un número ya fue reportado por fraude telefónico.';
      searchInput.type = 'tel';
      searchInput.placeholder = 'Ej. 55 1234 5678';
      searchInput.setAttribute('aria-label', 'Número de teléfono a buscar');
    } else {
      searchTitle.textContent = 'Buscar por nombre (hospedaje)';
      searchIntro.textContent = 'Consulta si alguien ya fue reportado por mal comportamiento en hospedaje/Airbnb. Solo se muestran reportes ya revisados y publicados.';
      searchInput.type = 'text';
      searchInput.placeholder = 'Nombre de la persona';
      searchInput.setAttribute('aria-label', 'Nombre de la persona a buscar');
    }
  }

  $('search-open-btn').addEventListener('click', () => {
    setSearchMode('phone');
    searchSheet.open(searchInput);
  });
  $('search-close').addEventListener('click', () => searchSheet.close());
  searchModePhoneBtn.addEventListener('click', () => setSearchMode('phone'));
  searchModeNameBtn.addEventListener('click', () => setSearchMode('name'));

  const resultCard = (html, extra = '') => `<div class="result-card${extra}">${html}</div>`;
  function showResultMessage(text, isError) {
    searchResults.innerHTML = '';
    const card = document.createElement('div');
    card.className = `result-card${isError ? ' status-msg status-err' : ' muted'}`;
    card.setAttribute('role', isError ? 'alert' : 'status');
    card.textContent = text;
    searchResults.appendChild(card);
  }

  // Busca la region LADA de un numero dentro de los datos ya cargados para el mapa.
  // Solo funciona si la vista trae una columna `lada`; si no, no se muestra nada.
  function lookupLadaRegion(phone) {
    if (!allLada.length || allLada.some((r) => r.lada === undefined)) return null;
    const national = phone.length > 10 ? phone.slice(-10) : phone;
    const match = [3, 2].map((len) => national.slice(0, len))
      .map((prefix) => allLada.find((r) => String(r.lada) === prefix))
      .find(Boolean);
    return match || null;
  }

  const PHONE_TIPS = `
    <ul class="tips">
      <li>Si te piden dinero, claves o códigos, cuelga y llama tú al banco al número oficial (el del reverso de tu tarjeta).</li>
      <li>Nunca compartas NIP, códigos por SMS ni el CVV por teléfono.</li>
      <li>Ante amenazas o extorsión puedes denunciar de forma anónima al 089.</li>
    </ul>`;
  const NAME_TIPS = `
    <ul class="tips">
      <li>Mantén conversación y pagos dentro de la plataforma de hospedaje.</li>
      <li>Desconfía de la prisa, de pagos por fuera y de precios demasiado bajos.</li>
      <li>Verifica el anuncio y los comentarios de otros huéspedes antes de pagar.</li>
    </ul>`;

  async function searchNumber() {
    const phone = normalizePhone(searchInput.value);
    if (phone.length < 8) {
      showResultMessage('Escribe un número válido.', true);
      return;
    }
    searchBtn.disabled = true;
    showResultMessage('Buscando...', false);

    const { data, error } = await supabase
      .from('phone_confidence')
      .select('*')
      .eq('phone_number', phone)
      .maybeSingle();

    searchBtn.disabled = false;

    if (error) {
      showResultMessage('Error al buscar. Intenta de nuevo.', true);
      return;
    }

    if (!data || data.report_count === 0) {
      const region = lookupLadaRegion(phone);
      const regionLine = region
        ? `<p class="muted">Esa región (${esc(region.region)}) tiene ${num(region.total_reports)} reporte${plural(num(region.total_reports), '', 's')} de fraude telefónico en total.</p>`
        : '';
      searchResults.innerHTML = resultCard(`
        <span class="badge badge-none">Sin reportes</span>
        <p><strong>Sin reportes no significa que sea seguro.</strong></p>
        <p class="muted">Nadie ha reportado este número todavía, pero eso no confirma que sea legítimo: los números de fraude cambian seguido.</p>
        ${regionLine}
        ${PHONE_TIPS}
        <p class="muted">Si te pasó algo, repórtalo con el botón del mapa.</p>`);
      return;
    }

    const count = num(data.report_count);
    const isHighConfidence = count >= 3;
    searchResults.innerHTML = resultCard(`
      <span class="badge ${isHighConfidence ? 'badge-high' : 'badge-low'}">
        ${isHighConfidence ? `${count} personas reportaron este número` : 'Reportado por pocas personas'}
      </span>
      <p>${count} reporte${plural(count, '', 's')} único${plural(count, '', 's')}, sin verificar</p>
      <p class="muted">Último reporte: ${esc(fmtDate(data.last_reported_at))}</p>
      ${PHONE_TIPS}
      <p class="disclaimer-line">Reportes de usuarios, no verificados por Radar Urbano. No implica que el titular de este número haya cometido un delito.</p>`);
  }

  // Busqueda por nombre: usa la RPC lookup_named (coincidencia exacta, minimo 5 caracteres).
  // Si la RPC aun no existe (migracion sin aplicar), cae a la vista anterior.
  async function lookupNamed(name) {
    const rpc = await supabase.rpc('lookup_named', { p_name: name });
    if (!rpc.error) {
      const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
      return { data: row ? { report_count: Number(row.report_count) || 0 } : null, error: null };
    }
    if (rpc.error.code === '22023') return { data: null, error: null, tooShort: true };
    if (rpc.error.code === 'PGRST202' || rpc.status === 404) {
      const legacy = await supabase
        .from('named_report_confidence')
        .select('*')
        .eq('value_normalized', name.trim().toLowerCase())
        .maybeSingle();
      return { data: legacy.data, error: legacy.error };
    }
    return { data: null, error: rpc.error };
  }

  async function searchName() {
    const name = searchInput.value.trim();
    if (name.length < 5) {
      showResultMessage('Escribe el nombre completo (mínimo 5 caracteres).', true);
      return;
    }
    searchBtn.disabled = true;
    showResultMessage('Buscando...', false);

    const { data, error, tooShort } = await lookupNamed(name);

    searchBtn.disabled = false;

    if (tooShort) {
      showResultMessage('Escribe el nombre completo (mínimo 5 caracteres).', true);
      return;
    }
    if (error) {
      showResultMessage('Error al buscar. Intenta de nuevo.', true);
      return;
    }

    if (!data || data.report_count === 0) {
      searchResults.innerHTML = resultCard(`
        <span class="badge badge-none">Sin reportes publicados</span>
        <p><strong>Sin reportes no significa que la persona sea de fiar.</strong></p>
        <p class="muted">Nadie con ese nombre tiene reportes ya revisados y publicados. Puede que no haya pasado nada, o que nadie haya reportado todavía.</p>
        ${NAME_TIPS}
        <p class="muted">Si te pasó algo, repórtalo con el botón "Hospedaje / Airbnb".</p>`);
      return;
    }

    const count = num(data.report_count);
    searchResults.innerHTML = resultCard(`
      <span class="badge ${count >= 2 ? 'badge-high' : 'badge-low'}">
        ${count} reporte${plural(count, '', 's')} publicado${plural(count, '', 's')}
      </span>
      ${NAME_TIPS}
      <p class="disclaimer-line">Reportes de usuarios, revisados por un moderador antes de publicarse. No implica que la persona haya cometido un delito ni es un registro oficial.</p>`);
  }

  searchBtn.addEventListener('click', () => (searchMode === 'phone' ? searchNumber() : searchName()));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (searchMode === 'phone' ? searchNumber() : searchName());
  });

  // =====================================================================
  // Reporte
  // =====================================================================
  const reportDialog = $('report-overlay');
  const reportForm = $('report-form');
  const reportThanks = $('report-thanks');
  const reportThanksTitle = $('report-thanks-title');
  const reportThanksText = $('report-thanks-text');
  const reportPhone = $('report-phone');
  const reportDescription = $('report-description');
  const reportLocationText = $('report-location-text');
  const useLocationBtn = $('use-location-btn');
  const locationStatus = $('location-status');
  const reportSubmitBtn = $('report-submit-btn');
  const reportStatus = $('report-status');
  const reportIntro = $('report-intro');
  const reportDisclaimer = $('report-disclaimer');
  const hospedajeContactLine = $('hospedaje-contact-line');
  const incidentFields = $('incident-fields');
  const hospedajeFields = $('hospedaje-fields');
  const reportModeIncidentBtn = $('report-mode-incident');
  const reportModeHospedajeBtn = $('report-mode-hospedaje');
  const hospedajeName = $('hospedaje-name');
  const hospedajeLink = $('hospedaje-link');
  const hospedajeImage = $('hospedaje-image');
  const hospedajeImageLabel = $('hospedaje-image-label');
  const HOSPEDAJE_IMAGE_LABEL_DEFAULT = hospedajeImageLabel.textContent;

  const INCIDENT_DISCLAIMER = 'Tu reporte se publica sin verificar. No lo uses para dañar a alguien a propósito — un reporte falso puede ser responsabilidad tuya, no de Radar Urbano.';
  const HOSPEDAJE_DISCLAIMER = 'Reporte pendiente de revisión — no es una acusación confirmada ni un registro oficial. Un reporte falso es tu responsabilidad, no de Radar Urbano. La imagen se guarda en privado; si se publica, solo se muestra un recorte revisado.';

  let reportMode = 'incident'; // 'incident' | 'hospedaje'
  let capturedLat = null;
  let capturedLon = null;

  const reportSheet = setupDialog(reportDialog);

  function setReportStatus(text, kind = '') {
    reportStatus.textContent = text;
    reportStatus.className = `status-msg${kind ? ` status-${kind}` : ''}`;
    reportStatus.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  }

  function setReportMode(mode) {
    reportMode = mode;
    setReportStatus('');
    const incident = mode === 'incident';
    setPressed(reportModeIncidentBtn, incident);
    setPressed(reportModeHospedajeBtn, !incident);
    incidentFields.hidden = !incident;
    hospedajeFields.hidden = incident;
    hospedajeContactLine.hidden = incident;
    reportIntro.textContent = incident
      ? 'Fraude telefónico, robo, asalto, lo que haya sido — no hace falta elegir categoría, nosotros la detectamos.'
      : 'Cuéntanos qué pasó. Un moderador revisa cada reporte antes de que se publique — no aparece solo.';
    reportDisclaimer.textContent = incident ? INCIDENT_DISCLAIMER : HOSPEDAJE_DISCLAIMER;
    reportSubmitBtn.textContent = incident ? 'Reportar' : 'Enviar a revisión';
  }

  function showReportForm() {
    reportForm.hidden = false;
    reportThanks.hidden = true;
    setReportMode('incident');
  }

  function showThanks(message) {
    reportForm.hidden = true;
    reportThanks.hidden = false;
    reportThanksText.textContent = message;
    reportThanksTitle.focus();
  }

  reportModeIncidentBtn.addEventListener('click', () => setReportMode('incident'));
  reportModeHospedajeBtn.addEventListener('click', () => setReportMode('hospedaje'));

  hospedajeImage.addEventListener('change', () => {
    hospedajeImageLabel.textContent = hospedajeImage.files[0]?.name || HOSPEDAJE_IMAGE_LABEL_DEFAULT;
  });

  $('fab').addEventListener('click', () => {
    showReportForm();
    reportSheet.open(reportDescription);
  });
  $('report-close').addEventListener('click', () => reportSheet.close());
  $('report-thanks-close').addEventListener('click', () => reportSheet.close());

  useLocationBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locationStatus.textContent = 'Tu navegador no soporta ubicación.';
      return;
    }
    locationStatus.textContent = 'Obteniendo ubicación...';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        capturedLat = pos.coords.latitude;
        capturedLon = pos.coords.longitude;
        locationStatus.textContent = 'Ubicación capturada';
      },
      () => {
        locationStatus.textContent = 'No se pudo obtener — escribe la zona abajo.';
      },
      { timeout: 8000 }
    );
  });

  // Gancho para Cloudflare Turnstile: cuando se cargue el widget, debe dejar el token
  // en window.turnstileToken. Hoy el insert directo a `reports` no tiene columna para
  // el token, asi que NO se envia; cuando el envio pase a RPC, pasarlo ahi.
  function getTurnstileToken() {
    return typeof window.turnstileToken === 'string' ? window.turnstileToken : null;
  }

  // Unico punto de escritura de reportes de incidente. Para cambiar a RPC solo se
  // modifica esta funcion. Devuelve { error } como supabase-js.
  async function submitReport(payload) {
    void getTurnstileToken();
    return supabase.from('reports').insert(payload);
  }

  async function handleIncidentSubmit() {
    const phone = normalizePhone(reportPhone.value);
    const description = reportDescription.value.trim();
    const locationText = reportLocationText.value.trim();
    const phoneTyped = reportPhone.value.trim().length > 0;

    if (description.length < 5) {
      setReportStatus('Describe qué pasó.', 'err');
      return;
    }
    if (phoneTyped && phone.length < 8) {
      setReportStatus('El número parece incompleto.', 'err');
      return;
    }
    if (phone.length < 8 && capturedLat === null && !locationText) {
      setReportStatus('Agrega un número, tu ubicación, o la zona donde pasó.', 'err');
      return;
    }

    reportSubmitBtn.disabled = true;
    setReportStatus('Enviando...');

    const payload = { description };
    if (phone.length >= 8) payload.phone_number = phone;
    if (capturedLat !== null) { payload.lat = capturedLat; payload.lon = capturedLon; }
    if (locationText) payload.location_text = locationText;

    const { error } = await submitReport(payload);

    reportSubmitBtn.disabled = false;

    if (error) {
      setReportStatus(
        error.code === 'rate_limited' ? error.message : 'No se pudo enviar el reporte. Intenta de nuevo.',
        'err'
      );
      return;
    }

    reportPhone.value = '';
    reportDescription.value = '';
    reportLocationText.value = '';
    locationStatus.textContent = '';
    capturedLat = null;
    capturedLon = null;
    setReportStatus('');
    showThanks('Reporte enviado. Gracias por ayudar a otros.');
  }

  // Reportes con nombre (hospedaje/Airbnb) nunca se auto-publican -- ver
  // submit_named_report() en la base de datos, que fuerza status='pending' sin
  // importar lo que mande este cliente.
  const HOSPEDAJE_RPC_ERRORS = {
    description_too_short: 'Describe qué pasó con un poco más de detalle.',
    subject_value_required: 'Escribe el nombre de la persona.',
    rate_limited_subject: 'Ya hay varios reportes recientes con ese nombre. Espera antes de mandar otro.',
  };

  async function handleHospedajeSubmit() {
    const name = hospedajeName.value.trim();
    const link = hospedajeLink.value.trim();
    const description = reportDescription.value.trim();
    const file = hospedajeImage.files[0];

    if (name.length < 2) {
      setReportStatus('Escribe el nombre de la persona.', 'err');
      return;
    }
    if (description.length < 5) {
      setReportStatus('Describe qué pasó.', 'err');
      return;
    }
    if (file && file.size > 8 * 1024 * 1024) {
      setReportStatus('La imagen pesa demasiado (máximo 8MB).', 'err');
      return;
    }

    reportSubmitBtn.disabled = true;
    setReportStatus('Enviando...');

    let evidenceStoragePath = null;
    if (file) {
      const path = `pending/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: uploadError } = await supabase.storage.from('evidence-private').upload(path, file);
      if (uploadError) {
        reportSubmitBtn.disabled = false;
        setReportStatus('No se pudo subir la imagen. Intenta de nuevo o envía el reporte sin ella.', 'err');
        return;
      }
      evidenceStoragePath = path;
    }

    const { error } = await supabase.rpc('submit_named_report', {
      p_description: description,
      p_category: 'hospedaje',
      p_subject_type: 'person_name',
      p_subject_value: name,
      p_reference_url: link || null,
      p_evidence_storage_path: evidenceStoragePath,
    });

    reportSubmitBtn.disabled = false;

    if (error) {
      const key = Object.keys(HOSPEDAJE_RPC_ERRORS).find((k) => error.message?.includes(k));
      setReportStatus(key ? HOSPEDAJE_RPC_ERRORS[key] : 'No se pudo enviar el reporte. Intenta de nuevo.', 'err');
      return;
    }

    hospedajeName.value = '';
    hospedajeLink.value = '';
    reportDescription.value = '';
    hospedajeImage.value = '';
    hospedajeImageLabel.textContent = HOSPEDAJE_IMAGE_LABEL_DEFAULT;
    setReportStatus('');
    showThanks('Reporte enviado a revisión. Un moderador lo revisa antes de publicarlo.');
  }

  reportSubmitBtn.addEventListener('click', () => {
    if (reportMode === 'incident') handleIncidentSubmit();
    else handleHospedajeSubmit();
  });

  // =====================================================================
  // Toast de zona
  // =====================================================================
  const zoneToast = $('zone-toast');
  const zoneToastText = $('zone-toast-text');

  function showToast(title, message, tone = '') {
    zoneToastText.textContent = '';
    const titleEl = document.createElement('span');
    titleEl.id = 'zone-toast-title';
    titleEl.textContent = title;
    zoneToastText.append(titleEl, document.createTextNode(message));

    zoneToast.classList.remove('tone-alert', 'tone-warn', 'tone-clear');
    if (tone) zoneToast.classList.add(tone);
    zoneToast.classList.add('visible');
    // Recorre los controles del mapa justo lo que mide el toast ya renderizado.
    document.documentElement.style.setProperty('--toast-offset', `${zoneToast.offsetHeight + 12}px`);
  }

  function hideToast() {
    zoneToast.classList.remove('visible');
    document.documentElement.style.setProperty('--toast-offset', '0px');
  }
  $('zone-toast-close').addEventListener('click', hideToast);

  // =====================================================================
  // Mapa
  // =====================================================================
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([23.6345, -102.5528], 5);
  window.__radarMap = map;
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 12,
  }).addTo(map);

  // El contenedor vive en un layout flex (100dvh); en algunos navegadores moviles
  // el tamano final se asienta despues del primer paint. Forzamos un recalculo.
  setTimeout(() => map.invalidateSize(), 100);
  window.addEventListener('resize', () => map.invalidateSize());

  const contextLayer = L.layerGroup();
  const ladaLayer = L.layerGroup().addTo(map);
  const incidentLayer = L.layerGroup().addTo(map);
  const trendLayer = L.layerGroup().addTo(map);

  let allIncidents = [];
  let allSesnsp = [];
  let duplicateCounts = new Map(); // id canonico -> numero de duplicados que lo confirman
  const activeCategories = new Set();
  let knownCategories = new Set();

  // --- Avisos del mapa: cargando / error con Reintentar / vacio ---
  const mapNotice = $('map-notice');
  const mapNoticeText = $('map-notice-text');
  const mapRetryBtn = $('map-retry');
  const mapEmpty = $('map-empty');

  function showMapNotice(text, withRetry) {
    mapNotice.hidden = false;
    mapNoticeText.textContent = text;
    mapNotice.setAttribute('role', withRetry ? 'alert' : 'status');
    mapRetryBtn.hidden = !withRetry;
    if (withRetry) mapRetryBtn.focus({ preventScroll: true });
  }
  function hideMapNotice() { mapNotice.hidden = true; }

  const CONTEXT_MIN_ZOOM = 5;
  function syncContextLayerVisibility() {
    const hasLayer = map.hasLayer(contextLayer);
    if (map.getZoom() >= CONTEXT_MIN_ZOOM && !hasLayer) contextLayer.addTo(map);
    else if (map.getZoom() < CONTEXT_MIN_ZOOM && hasLayer) map.removeLayer(contextLayer);
  }
  map.on('zoomend', syncContextLayerVisibility);

  // Capa 0: contexto de incidencia delictiva oficial (SESNSP) -- fondo ambar tenue por municipio.
  async function loadSesnsp() {
    let rows = cacheGet('sesnsp', SESNSP_TTL);
    if (!rows) {
      const { data, error } = await supabase
        .from('sesnsp_municipal_crime')
        .select('total_delitos, total_robos, municipio_coordinates(municipio, estado, lat, lon)')
        .order('total_delitos', { ascending: false });
      if (error) throw error;
      rows = data || [];
      cacheSet('sesnsp', rows);
    }
    allSesnsp = rows.filter((row) => row.municipio_coordinates);
    contextLayer.clearLayers();
    allSesnsp.forEach((row) => {
      const muni = row.municipio_coordinates;
      const radius = Math.min(4 + Math.sqrt(num(row.total_delitos)) * 0.35, 22);
      L.circleMarker([muni.lat, muni.lon], {
        radius,
        color: '#e3b34a',
        weight: 1.5,
        dashArray: '3,4', // punteado: se lee como "historico"
        fillColor: '#e3b34a',
        fillOpacity: 0.18,
      })
        .addTo(contextLayer)
        .bindPopup(`<strong>${esc(muni.municipio)}, ${esc(muni.estado)}</strong><br><span class="muted">Contexto SESNSP (histórico)</span><br>${esc(num(row.total_delitos).toLocaleString('es-MX'))} delitos/año · ${esc(num(row.total_robos).toLocaleString('es-MX'))} robos`);
    });
    syncContextLayerVisibility();
  }

  // Capa 1: fraude telefonico agregado por region (LADA).
  async function loadLada() {
    let rows = cacheGet('lada', LADA_TTL);
    if (!rows) {
      const { data, error } = await supabase
        .from('fraud_counts_by_lada')
        .select('*')
        .gt('total_reports', 0);
      if (error) throw error;
      rows = data || [];
      cacheSet('lada', rows);
    }
    allLada = rows;
    ladaLayer.clearLayers();
    rows.forEach((row) => {
      const total = num(row.total_reports);
      const radius = Math.min(10 + total * 3, 48);
      L.circleMarker([row.lat, row.lon], {
        radius,
        color: '#e34a4a',
        weight: 2,
        fillColor: '#e34a4a',
        fillOpacity: 0.35,
      })
        .addTo(ladaLayer)
        .bindPopup(`<strong>${esc(row.region)}</strong><br>${total} reporte${plural(total, '', 's')} de fraude telefónico`);
    });
  }

  // Capa 2: incidentes con ubicacion GPS (coordenadas ya difuminadas a ~1km en el servidor).
  // Ventana de 90 dias; el filtro de tiempo/categoria es client-side sobre este set.
  const INCIDENT_LIMIT = 2000;
  async function loadIncidents() {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('reports')
      .select('id, lat, lon, category, entities, created_at, duplicate_of')
      .is('duplicate_of', null)
      .not('lat', 'is', null)
      .gte('created_at', ninetyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(INCIDENT_LIMIT);
    if (error) throw error;
    allIncidents = data || [];

    // Confirmaciones: los duplicados ya no vienen en la consulta principal; se piden
    // aparte solo con la columna que hace falta. Si falla, solo se pierde el contador.
    duplicateCounts = new Map();
    try {
      const { data: dups, error: dupErr } = await supabase
        .from('reports')
        .select('duplicate_of')
        .not('duplicate_of', 'is', null)
        .gte('created_at', ninetyDaysAgo)
        .order('created_at', { ascending: false })
        .limit(INCIDENT_LIMIT);
      if (!dupErr && dups) {
        dups.forEach((d) => duplicateCounts.set(d.duplicate_of, (duplicateCounts.get(d.duplicate_of) || 0) + 1));
      }
    } catch (err) {
      console.warn('No se pudieron cargar confirmaciones', err);
    }

    buildCategoryChips();
    renderIncidents();
  }

  // Capa 3: tendencias emergentes (3+ reportes no duplicados en 7 dias).
  async function loadTrends() {
    const { data, error } = await supabase.from('trending_clusters').select('*');
    if (error) throw error;
    trendLayer.clearLayers();
    if (!data || data.length === 0) return;

    data.forEach((row) => {
      const cats = (row.categories || []).map((c) => String(c).replace(/_/g, ' ')).join(', ') || 'sin clasificar';
      const total = num(row.report_count);
      const icon = L.divIcon({
        className: 'trend-marker',
        html: '<div class="trend-pulse"></div><div class="trend-dot">⚠️</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      L.marker([row.lat, row.lon], { icon, keyboard: false })
        .addTo(trendLayer)
        .bindPopup(`<strong>⚠️ Más reportes de lo usual</strong><br>${total} reportes de usuarios en los últimos 7 días, sin verificar<br><span class="muted">${esc(cats)}</span>`);
    });

    const zones = data.length;
    const total = data.reduce((s, r) => s + num(r.report_count), 0);
    showToast(
      '⚠️ Más reportes de lo usual',
      `${zones} zona${plural(zones, '', 's')} con más reportes de usuarios de lo normal esta semana (${total} en total, sin verificar). Búscalas en el mapa (⚠️).`,
      'tone-alert'
    );
  }

  const LAYERS = [
    ['contexto histórico', loadSesnsp],
    ['fraude por región', loadLada],
    ['incidentes', loadIncidents],
    ['tendencias', loadTrends],
  ];

  async function loadAllLayers() {
    showMapNotice('Cargando mapa...', false);
    const results = await Promise.allSettled(LAYERS.map(([, fn]) => fn()));
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? LAYERS[i][0] : null))
      .filter(Boolean);
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`Capa fallida: ${LAYERS[i][0]}`, r.reason);
    });
    if (failed.length) {
      showMapNotice(`No se pudo cargar: ${failed.join(', ')}.`, true);
    } else {
      hideMapNotice();
    }
  }
  mapRetryBtn.addEventListener('click', loadAllLayers);

  // --- Filtros: categoria y tiempo ---
  const timeFilter = $('time-filter');
  const timeFilterLabel = $('time-filter-label');
  const categoryChipsEl = $('category-chips');

  function buildCategoryChips() {
    const categories = [...new Set(allIncidents.map((r) => r.category || 'sin_clasificar'))];
    // En un reintento se conserva la seleccion previa; las categorias nuevas nacen activas.
    categories.forEach((c) => { if (!knownCategories.has(c)) activeCategories.add(c); });
    knownCategories = new Set(categories);
    categoryChipsEl.textContent = '';
    categories.forEach((c) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.category = c;
      chip.textContent = c.replace(/_/g, ' ');
      setPressed(chip, activeCategories.has(c));
      chip.addEventListener('click', () => {
        const on = !activeCategories.has(c);
        if (on) activeCategories.add(c); else activeCategories.delete(c);
        setPressed(chip, on);
        renderIncidents();
      });
      categoryChipsEl.appendChild(chip);
    });
  }

  // Recencia visual: mas reciente = mas opaco/grande (90 dias = minimo).
  function recencyStyle(createdAt) {
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000);
    const t = Math.min(ageDays / 90, 1);
    return {
      fillOpacity: 0.6 - t * 0.42,
      radius: 9 - t * 3,
    };
  }

  let viewMode = 'points'; // 'points' | 'heat'
  let heatLayer = null;

  function renderIncidents() {
    incidentLayer.clearLayers();
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    const days = Number(timeFilter.value);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const visible = allIncidents
      .filter((row) => !row.duplicate_of)
      .filter((row) => new Date(row.created_at).getTime() >= cutoff)
      .filter((row) => activeCategories.has(row.category || 'sin_clasificar'));

    // Sin este contador, con pocos reportes mover el slider parece no hacer nada.
    timeFilterLabel.textContent = `${days}d · ${visible.length}`;
    timeFilter.setAttribute('aria-valuetext', `${days} días, ${visible.length} reportes visibles`);
    mapEmpty.hidden = visible.length > 0;

    if (viewMode === 'heat') {
      if (!heatAvailable) return;
      const livePoints = visible.map((row) => {
        const ageDays = (Date.now() - new Date(row.created_at).getTime()) / (24 * 60 * 60 * 1000);
        const recencyWeight = Math.max(0.3, 1 - ageDays / 90);
        const confirmWeight = 1 + (duplicateCounts.get(row.id) || 0) * 0.5;
        return [row.lat, row.lon, recencyWeight * confirmWeight];
      });
      // El contexto SESNSP alimenta el calor con menos peso que lo vivo.
      const contextPoints = allSesnsp.map((row) => {
        const muni = row.municipio_coordinates;
        const weight = Math.min(num(row.total_delitos) / 3000, 1) * 0.7;
        return [muni.lat, muni.lon, weight];
      });
      heatLayer = L.heatLayer([...contextPoints, ...livePoints], {
        radius: 34,
        blur: 24,
        maxZoom: 12,
        max: 0.6,
        minOpacity: 0.35,
        gradient: { 0.15: '#2a2e8c', 0.4: '#8ca0ff', 0.7: '#e3b34a', 1: '#e34a4a' },
      });
      heatLayer.addTo(map);
      return;
    }

    visible.forEach((row) => {
      const label = String(row.category || 'incidente').replace(/_/g, ' ');
      const entityBits = [];
      if (row.entities?.time_of_day) entityBits.push(row.entities.time_of_day);
      if (row.entities?.weapon) entityBits.push(row.entities.weapon);
      if (row.entities?.vehicle) entityBits.push(row.entities.vehicle);
      const entityLine = entityBits.length
        ? `<br><span class="muted">${entityBits.map(esc).join(' · ')}</span>`
        : '';
      const confirmCount = duplicateCounts.get(row.id) || 0;
      const confirmLine = confirmCount > 0
        ? `<br><span class="muted">Reportado por ${confirmCount + 1} personas</span>`
        : '';
      const { fillOpacity, radius } = recencyStyle(row.created_at);

      L.circleMarker([row.lat, row.lon], {
        radius: confirmCount > 0 ? radius + 3 : radius,
        color: '#8ca0ff',
        weight: 2,
        fillColor: '#8ca0ff',
        fillOpacity,
      })
        .addTo(incidentLayer)
        .bindPopup(`<strong>${esc(label)}</strong><br>${esc(fmtDate(row.created_at))}${entityLine}${confirmLine}<br><span class="disclaimer-line">Reporte de usuario, sin verificar</span>`);
    });
  }

  const heatToggle = $('heat-toggle');
  if (!heatAvailable) {
    heatToggle.disabled = true;
    heatToggle.title = 'El mapa de calor no está disponible en este momento';
  }
  heatToggle.addEventListener('click', () => {
    viewMode = viewMode === 'points' ? 'heat' : 'points';
    const heat = viewMode === 'heat';
    heatToggle.textContent = heat ? 'Puntos' : 'Calor';
    heatToggle.title = heat ? 'Ver como puntos' : 'Ver como mapa de calor';
    heatToggle.setAttribute('aria-pressed', heat ? 'true' : 'false');
    heatToggle.classList.toggle('active', heat);
    renderIncidents();
  });

  // Slider con debounce de 150 ms; la etiqueta de dias responde al instante.
  let renderTimer = null;
  timeFilter.addEventListener('input', () => {
    timeFilterLabel.textContent = `${timeFilter.value}d`;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderIncidents, 150);
  });

  loadAllLayers();

  // =====================================================================
  // Resumen de zona con IA
  // =====================================================================
  let zoneCenterMarker = null;
  function markZoneCenter(center) {
    if (zoneCenterMarker) map.removeLayer(zoneCenterMarker);
    zoneCenterMarker = L.circleMarker([center.lat, center.lng], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#4ac97f',
      fillOpacity: 1,
    })
      .addTo(map)
      .bindPopup(center.isRealLocation ? 'Tu ubicación' : 'Centro de la zona analizada');
  }

  function getZoneCenter() {
    // Prioridad: ubicacion real (GPS). Sin permiso, cae al centro visible del mapa.
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ ...map.getCenter(), isRealLocation: false });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, isRealLocation: true }),
        () => resolve({ ...map.getCenter(), isRealLocation: false }),
        { timeout: 6000 }
      );
    });
  }

  $('zone-summary-btn').addEventListener('click', async () => {
    showToast('Ubicación', 'Obteniendo tu ubicación...');

    const center = await getZoneCenter();

    // Zoom 12 es el maximo que sirve la capa de tiles (maxZoom: 12).
    map.setView([center.lat, center.lng], 12);
    markZoneCenter(center);

    showToast(
      center.isRealLocation ? 'Tu zona' : 'Zona en pantalla',
      center.isRealLocation
        ? 'Analizando reportes cerca de ti...'
        : 'No se pudo usar tu ubicación — analizando lo que ves en el mapa...'
    );

    // La consulta a reportes vive del lado del servidor: el navegador solo manda lat/lng.
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/summarize-zone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ lat: center.lat, lng: center.lng }),
      });
      const json = await res.json();
      const tone = ['tone-alert', 'tone-warn', 'tone-clear'].includes(json.tone) ? json.tone : 'tone-clear';
      showToast(json.title || 'Resumen de zona', json.summary || 'No se pudo generar el resumen.', tone);
    } catch {
      showToast('Error', 'No se pudo generar el resumen. Intenta de nuevo.');
    }
  });

  // ---- Enlaces para asistentes de IA (ver /agentes.html) ----
  //   /?buscar=<telefono>                                    abre la busqueda de un numero
  //   /?reportar=1&telefono=...&descripcion=...&zona=...     abre el reporte PRELLENADO
  // Los parametros solo prellenan: nunca se envia nada solo. La persona revisa y confirma.
  (function applyAgentLink() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }

    const buscar = normalizePhone(params.get('buscar') || '');
    if (buscar.length >= 8 && buscar.length <= 15) {
      setSearchMode('phone');
      searchInput.value = buscar;
      searchSheet.open(searchInput);
      searchNumber();
      return;
    }

    if (params.get('reportar') === '1') {
      showReportForm();
      const tel = normalizePhone(params.get('telefono') || '');
      if (tel.length >= 8 && tel.length <= 15) reportPhone.value = tel;
      reportDescription.value = (params.get('descripcion') || '').slice(0, 1000);
      reportLocationText.value = (params.get('zona') || '').slice(0, 200);
      reportSheet.open(reportDescription);
      setReportStatus('Reporte prellenado por un asistente. Revísalo, corrígelo y envíalo tú.');
    }
  })();
}

setupShare();
boot();
