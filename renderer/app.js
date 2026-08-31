/* =====================================================================
   EK050 Flight Widget - Renderer
   Holt die Flugdaten (ueber den Main-Prozess, im Browser direkt),
   zeichnet Karte + Route und fuellt die Instrumentenanzeigen.
   ===================================================================== */
(function () {
  'use strict';

  var CONFIG = window.EK_CONFIG;
  var api = window.widget || null; // in Electron vorhanden
  var STORAGE_KEY = 'ek050.track.v1';
  var THEME_KEY = 'ek050.theme';

  var state = {
    theme: 'ecam',
    aircraft: null,
    lastFix: null, // letzte echte Position (fuer Koppelnavigation)
    track: [], // [{lat, lon, t, alt, gs}]
    nextRefreshAt: null,
    source: null,
    loading: false,
    pinned: true
  };

  var el = {};
  ['identFlight','identCallsign','identOrigin','identDest','btnTheme','btnRefresh','btnPin','btnMin','btnClose',
   'statusLed','statusText','statusSource','statusNext','ovlPos','ovlGs','ovlRemain','ovlEta',
   'progOrigin','progDest','progFlown','progRemaining','progPct','progFill','progMarker',
   'valGs','subGs','valAlt','subAlt','valTrk','subTrk','valVs','subVs','valPos','subPos',
   'valMach','subMach','valEta','subEta','valAcft','subAcft','footerLeft','footerRight','shell']
    .forEach(function (id) { el[id] = document.getElementById(id); });

  /* ---------- Hilfsfunktionen ---------- */

  function pad(n, len) { return String(n).padStart(len || 2, '0'); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function timeIn(tz, date) {
    try {
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      }).format(date);
    } catch (err) {
      return '--:--';
    }
  }

  function utcTime(date) {
    return pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + 'z';
  }

  function minutesToHm(mins) {
    if (!isFinite(mins) || mins < 0) return '—';
    var h = Math.floor(mins / 60);
    var m = Math.round(mins % 60);
    return h > 0 ? h + ' h ' + pad(m) + ' min' : m + ' min';
  }

  function compassPoint(deg) {
    var names = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return names[Math.round(((deg % 360) / 22.5)) % 16];
  }

  function loadTrack() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(raw)) state.track = raw.slice(-CONFIG.maxTrackPoints);
    } catch (err) { state.track = []; }
  }

  function saveTrack() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.track.slice(-CONFIG.maxTrackPoints)));
    } catch (err) { /* Speicher voll oder gesperrt - nicht kritisch */ }
  }

  function pushTrackPoint(ac) {
    var last = state.track[state.track.length - 1];
    var point = { lat: ac.lat, lon: ac.lon, t: ac.observedAt, alt: ac.altitudeFt, gs: ac.groundSpeedKt };
    if (last && GEO.distanceNm(last, point) < 0.5) {
      state.track[state.track.length - 1] = point; // gleiche Position, nur auffrischen
    } else {
      state.track.push(point);
      if (state.track.length > CONFIG.maxTrackPoints) state.track.shift();
    }
    saveTrack();
  }

  /* ---------- Karte ---------- */

  var map = null;
  var layers = {};
  var tileLayer = null;

  var TILES = {
    ecam: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
      attribution: '© OpenStreetMap · © CARTO'
    },
    glass: {
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      attribution: '© OpenStreetMap · © CARTO'
    }
  };

  var COLORS = {
    ecam: { plan: '#1f6f52', flown: '#00ff9c', remaining: '#ffb000', acft: '#00ff9c' },
    glass: { plan: 'rgba(255,255,255,0.35)', flown: '#7ec8ff', remaining: 'rgba(190,140,255,0.9)', acft: '#ffffff' }
  };

  function airportMarker(apt, label) {
    return L.marker([apt.lat, apt.lon], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'apt-marker',
        html: '<div class="apt-dot"></div><div class="apt-label">' + label + '</div>',
        iconSize: [10, 10],
        iconAnchor: [5, 5]
      })
    });
  }

  function aircraftIcon(track) {
    var color = COLORS[state.theme].acft;
    var svg =
      '<svg width="34" height="34" viewBox="0 0 34 34" style="transform: rotate(' + (track || 0) + 'deg);">' +
      '<g fill="' + color + '" stroke="rgba(0,0,0,0.55)" stroke-width="0.6">' +
      '<path d="M17 2 L19.2 12.4 L31 19.4 L31 22.2 L19.2 18.6 L18.6 27.4 L22.4 30.2 L22.4 32 L17 30.4 L11.6 32 L11.6 30.2 L15.4 27.4 L14.8 18.6 L3 22.2 L3 19.4 L14.8 12.4 Z"/>' +
      '</g></svg>';
    return L.divIcon({ className: 'acft-icon', html: svg, iconSize: [34, 34], iconAnchor: [17, 17] });
  }

  function initMap() {
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      preferCanvas: true
    });
    map.setView([37, 33], 4);

    layers.plan = L.polyline([], { color: COLORS.ecam.plan, weight: 1, opacity: 0.9, dashArray: '2 6' }).addTo(map);
    layers.remaining = L.polyline([], { color: COLORS.ecam.remaining, weight: 2, opacity: 0.9, dashArray: '8 6' }).addTo(map);
    layers.flown = L.polyline([], { color: COLORS.ecam.flown, weight: 2.5, opacity: 1 }).addTo(map);
    layers.origin = airportMarker(CONFIG.origin, CONFIG.origin.iata).addTo(map);
    layers.destination = airportMarker(CONFIG.destination, CONFIG.destination.iata).addTo(map);
    layers.aircraft = L.marker([CONFIG.origin.lat, CONFIG.origin.lon], {
      icon: aircraftIcon(0), interactive: false, keyboard: false, zIndexOffset: 1000
    }).addTo(map);

    applyTileLayer();
    // Geplante Grosskreisroute einmalig zeichnen
    layers.plan.setLatLngs(GEO.greatCircle(CONFIG.origin, CONFIG.destination, 128).map(toLatLng));
    fitRoute();
  }

  function toLatLng(p) { return [p.lat, p.lon]; }

  function applyTileLayer() {
    var conf = TILES[state.theme] || TILES.ecam;
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(conf.url, {
      attribution: conf.attribution,
      subdomains: 'abcd',
      maxZoom: 12,
      minZoom: 2,
      crossOrigin: true
    }).addTo(map);
    var c = COLORS[state.theme];
    layers.plan.setStyle({ color: c.plan });
    layers.flown.setStyle({ color: c.flown });
    layers.remaining.setStyle({ color: c.remaining });
    if (state.aircraft) layers.aircraft.setIcon(aircraftIcon(state.aircraft.trackDeg || 0));
  }

  var userMovedMap = false;
  function fitRoute() {
    if (userMovedMap) return;
    var pts = [toLatLng(CONFIG.origin), toLatLng(CONFIG.destination)];
    if (state.aircraft) pts.push([state.aircraft.lat, state.aircraft.lon]);
    map.fitBounds(L.latLngBounds(pts).pad(0.18), { animate: false });
  }

  function drawFlight(ac) {
    var flown = state.track.map(toLatLng);
    // Vor dem ersten Fix die Grosskreislinie ab Start als "geflogen" annehmen
    var head = state.track.length ? state.track[0] : ac;
    var lead = GEO.greatCircle(CONFIG.origin, head, 48).map(toLatLng);
    layers.flown.setLatLngs(lead.concat(flown));
    layers.remaining.setLatLngs(GEO.greatCircle(ac, CONFIG.destination, 96).map(toLatLng));
    layers.aircraft.setLatLng([ac.lat, ac.lon]);
    layers.aircraft.setIcon(aircraftIcon(ac.trackDeg || GEO.bearingDeg(ac, CONFIG.destination)));
    fitRoute();
  }

  /* ---------- Anzeige ---------- */

  function setStatus(kind, text) {
    el.statusLed.className = 'status-led ' + kind;
    el.statusText.textContent = text;
    el.statusText.classList.toggle('warn', kind === 'lost');
  }

  function render(ac, meta) {
    meta = meta || {};
    var now = new Date();
    var hasPos = ac && isNum(ac.lat) && isNum(ac.lon);

    if (!hasPos) {
      setStatus('lost', 'KEINE POSITION VERFUEGBAR');
      el.statusSource.textContent = 'SRC —';
      return;
    }

    var gs = isNum(ac.groundSpeedKt) ? ac.groundSpeedKt : null;
    var totalNm = GEO.distanceNm(CONFIG.origin, CONFIG.destination);
    var flownNm = GEO.distanceNm(CONFIG.origin, ac);
    var remainNm = GEO.distanceNm(ac, CONFIG.destination);
    var pct = GEO.progressFraction(CONFIG.origin, CONFIG.destination, ac) * 100;
    var etaMin = gs && gs > 40 ? (remainNm / gs) * 60 : null;
    var etaDate = etaMin !== null ? new Date(now.getTime() + etaMin * 60000) : null;

    /* Kopf / Status */
    var estimated = Boolean(meta.estimated);
    var ageSec = isNum(ac.positionAgeSec) ? ac.positionAgeSec : Math.round((Date.now() - ac.observedAt) / 1000);
    if (estimated) {
      setStatus('stale', 'KEIN ADS-B KONTAKT · KOPPELNAVIGATION (' + minutesToHm(ageSec / 60) + ')');
    } else if (ageSec > 300) {
      setStatus('stale', 'POSITION VERALTET · ' + minutesToHm(ageSec / 60) + ' ALT');
    } else if (ac.onGround) {
      setStatus('live', 'AM BODEN');
    } else {
      setStatus('live', 'IM FLUG · ADS-B KONTAKT');
    }
    el.statusSource.textContent = 'SRC ' + String(ac.source || '—').toUpperCase();

    /* Karten-Overlays */
    el.ovlPos.textContent = GEO.formatLat(ac.lat) + ' ' + GEO.formatLon(ac.lon);
    el.ovlGs.innerHTML = (gs !== null ? Math.round(gs) : '—') + ' <small>kt</small>';
    el.ovlRemain.innerHTML = Math.round(remainNm) + ' <small>NM</small>';
    el.ovlEta.textContent = etaDate ? timeIn(CONFIG.destination.tz, etaDate) + ' LT' : '—';

    /* Fortschritt */
    el.progFlown.textContent = Math.round(flownNm) + ' NM';
    el.progRemaining.textContent = Math.round(remainNm) + ' NM';
    el.progPct.textContent = pct.toFixed(0) + '%';
    el.progFill.style.width = pct.toFixed(1) + '%';
    el.progMarker.style.left = pct.toFixed(1) + '%';

    /* Messwerte */
    el.valGs.textContent = gs !== null ? Math.round(gs) : '---';
    el.subGs.textContent = gs !== null ? Math.round(gs * 1.852) + ' km/h' : '— km/h';

    var alt = isNum(ac.altitudeFt) ? ac.altitudeFt : null;
    el.valAlt.textContent = alt !== null ? alt.toLocaleString('de-DE') : '---';
    el.subAlt.textContent = alt !== null
      ? (alt >= 18000 ? 'FL' + pad(Math.round(alt / 100), 3) : Math.round(alt * 0.3048) + ' m')
      : 'FL---';

    var trk = isNum(ac.trackDeg) ? ac.trackDeg : null;
    el.valTrk.textContent = trk !== null ? pad(Math.round(trk), 3) : '---';
    el.subTrk.textContent = trk !== null ? compassPoint(trk) : '—';

    var vs = isNum(ac.verticalRateFpm) ? Math.round(ac.verticalRateFpm / 50) * 50 : null;
    el.valVs.textContent = vs !== null ? (vs > 0 ? '+' + vs : String(vs)) : '---';
    el.subVs.textContent = vs === null ? '—' : vs > 200 ? 'STEIGFLUG' : vs < -200 ? 'SINKFLUG' : 'REISEFLUG';

    el.valPos.textContent = GEO.formatLat(ac.lat);
    el.subPos.textContent = GEO.formatLon(ac.lon);

    var machTxt = isNum(ac.mach) ? 'M ' + ac.mach.toFixed(3) : '—';
    var tas = isNum(ac.trueAirSpeedKt) ? ac.trueAirSpeedKt : null;
    el.valMach.textContent = machTxt;
    el.subMach.textContent = tas !== null ? 'TAS ' + Math.round(tas) + ' kt' : 'BRG ' + pad(Math.round(GEO.bearingDeg(ac, CONFIG.destination)), 3) + '°';

    el.valEta.textContent = etaDate ? timeIn(CONFIG.destination.tz, etaDate) : '--:--';
    el.subEta.textContent = etaMin !== null ? 'noch ' + minutesToHm(etaMin) : '—';

    el.valAcft.textContent = ac.registration || 'A6-???';
    el.subAcft.textContent = (ac.aircraftType ? ac.aircraftType + ' · ' : '') + 'SQK ' + (ac.squawk || '----');

    el.footerLeft.textContent =
      CONFIG.flightIata + ' · ' + (ac.registration || 'A6-???') + ' · ' +
      CONFIG.origin.iata + '/' + CONFIG.origin.icao + ' → ' + CONFIG.destination.iata + '/' + CONFIG.destination.icao +
      ' · ' + Math.round(totalNm) + ' NM GESAMT';
    el.footerRight.textContent = 'UPD ' + utcTime(now) + ' · ' + timeIn(CONFIG.origin.tz, now) + ' MUC · ' + timeIn(CONFIG.destination.tz, now) + ' DXB';

    drawFlight(ac);
  }

  /* ---------- Koppelnavigation, wenn der Kontakt abreisst ---------- */

  function deadReckon(fix) {
    if (!fix || !isNum(fix.groundSpeedKt) || !isNum(fix.trackDeg)) return null;
    var hours = (Date.now() - fix.observedAt) / 3600000;
    if (hours <= 0) return fix;
    var nm = fix.groundSpeedKt * hours;
    var toDest = GEO.distanceNm(fix, CONFIG.destination);
    var moved = GEO.destination(fix, fix.trackDeg, Math.min(nm, toDest));
    return Object.assign({}, fix, { lat: moved.lat, lon: moved.lon, positionAgeSec: Math.round(hours * 3600) });
  }

  /* ---------- Datenabruf ---------- */

  async function fetchDirect() {
    // Fallback fuer den Browserbetrieb (ohne Electron): direkt beim Feed anfragen
    var urls = [
      'https://api.adsb.lol/v2/callsign/' + CONFIG.callsign,
      'https://opendata.adsb.fi/api/v2/callsign/' + CONFIG.callsign,
      'https://api.airplanes.live/v2/callsign/' + CONFIG.callsign
    ];
    for (var i = 0; i < urls.length; i += 1) {
      try {
        var res = await fetch(urls[i], { cache: 'no-store' });
        if (!res.ok) continue;
        var json = await res.json();
        var list = (json && (json.ac || json.aircraft)) || [];
        if (!list.length) continue;
        var a = list[0];
        if (!isNum(Number(a.lat))) continue;
        return {
          ok: true,
          aircraft: {
            source: new URL(urls[i]).hostname,
            icao24: a.hex, callsign: (a.flight || '').trim(), registration: a.r || null, aircraftType: a.t || null,
            lat: Number(a.lat), lon: Number(a.lon),
            altitudeFt: a.alt_baro === 'ground' ? 0 : Number(a.alt_baro),
            groundSpeedKt: Number(a.gs), trackDeg: Number(a.track),
            verticalRateFpm: Number(a.baro_rate), mach: Number(a.mach),
            trueAirSpeedKt: Number(a.tas), squawk: a.squawk || null,
            onGround: a.alt_baro === 'ground',
            positionAgeSec: Number(a.seen_pos), observedAt: Date.now()
          },
          checkedAt: Date.now()
        };
      } catch (err) { /* naechste Quelle versuchen */ }
    }
    return { ok: false, aircraft: null, checkedAt: Date.now(), error: 'feeds' };
  }

  function handleResult(result) {
    state.loading = false;
    el.btnRefresh.classList.remove('active');
    state.nextRefreshAt = (result && result.nextRefreshAt) || Date.now() + CONFIG.refreshIntervalMs;

    if (result && result.ok && result.aircraft) {
      state.aircraft = result.aircraft;
      state.lastFix = result.aircraft;
      pushTrackPoint(result.aircraft);
      render(result.aircraft, { estimated: false });
      return;
    }

    // Kein Kontakt: letzte bekannte Position fortschreiben
    var estimate = deadReckon(state.lastFix);
    if (estimate) {
      state.aircraft = estimate;
      render(estimate, { estimated: true });
    } else if (result && result.error === 'feeds') {
      setStatus('lost', 'FEEDS NICHT ERREICHBAR · NAECHSTER VERSUCH LAEUFT');
      el.statusSource.textContent = 'SRC —';
    } else {
      setStatus('lost', 'KEIN ADS-B KONTAKT · KEINE VORHERIGE POSITION');
      el.statusSource.textContent = 'SRC —';
    }
  }

  async function refresh(reason) {
    if (state.loading) return;
    state.loading = true;
    el.btnRefresh.classList.add('active');
    setStatus('loading', 'ABFRAGE LAEUFT…');
    try {
      var result = api ? await api.refresh(reason) : await fetchDirect();
      handleResult(result);
    } catch (err) {
      handleResult({ ok: false, error: String(err && err.message) });
    }
  }

  /* ---------- Countdown ---------- */

  function tickCountdown() {
    if (!state.nextRefreshAt) { el.statusNext.textContent = 'NEXT —'; return; }
    var secs = Math.max(0, Math.round((state.nextRefreshAt - Date.now()) / 1000));
    el.statusNext.textContent = 'NEXT ' + pad(Math.floor(secs / 60)) + ':' + pad(secs % 60);
  }

  /* ---------- Design ---------- */

  function setTheme(theme) {
    state.theme = theme === 'glass' ? 'glass' : 'ecam';
    document.documentElement.setAttribute('data-theme', state.theme);
    el.btnTheme.textContent = state.theme === 'ecam' ? 'ECAM' : 'GLASS';
    el.btnTheme.title = state.theme === 'ecam' ? 'Zu Liquid-Glass wechseln (T)' : 'Zu ECAM-Terminal wechseln (T)';
    try { localStorage.setItem(THEME_KEY, state.theme); } catch (err) {}
    if (api) api.saveSettings({ theme: state.theme });
    if (map) applyTileLayer();
  }

  function toggleTheme() { setTheme(state.theme === 'ecam' ? 'glass' : 'ecam'); }

  /* ---------- Groessenanpassung ---------- */

  function applyResponsiveClasses() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    el.shell.classList.toggle('compact', w < 470);
    el.shell.classList.toggle('tiny', w < 360 || h < 420);
    el.shell.classList.toggle('short', h < 640);
    el.shell.classList.toggle('shorter', h < 540);
    if (map) map.invalidateSize({ animate: false });
  }

  /* ---------- Start ---------- */

  async function boot() {
    el.identFlight.textContent = CONFIG.flightIata;
    el.identCallsign.textContent = CONFIG.callsign;
    el.identOrigin.textContent = CONFIG.origin.iata;
    el.identDest.textContent = CONFIG.destination.iata;
    el.progOrigin.textContent = CONFIG.origin.iata;
    el.progDest.textContent = CONFIG.destination.iata;

    var savedTheme = null;
    try { savedTheme = localStorage.getItem(THEME_KEY); } catch (err) {}
    if (api) {
      try {
        var settings = await api.getSettings();
        savedTheme = savedTheme || (settings && settings.theme);
        state.pinned = !settings || settings.alwaysOnTop !== false;
      } catch (err) {}
    }
    setTheme(savedTheme || 'ecam');
    el.btnPin.classList.toggle('active', state.pinned);

    if (!api) {
      // Browserbetrieb: Fenstersteuerung gibt es nur in der Desktop-App
      el.shell.classList.add('web');
      [el.btnPin, el.btnMin, el.btnClose].forEach(function (btn) { btn.style.display = 'none'; });
    }

    loadTrack();
    initMap();
    map.on('zoomstart dragstart', function () { userMovedMap = true; });
    // Doppelklick auf die Karte: Automatik-Zoom wieder aktivieren
    map.on('dblclick', function () { userMovedMap = false; fitRoute(); });

    if (state.track.length) {
      var last = state.track[state.track.length - 1];
      state.lastFix = { lat: last.lat, lon: last.lon, altitudeFt: last.alt, groundSpeedKt: last.gs,
        trackDeg: GEO.bearingDeg(last, CONFIG.destination), observedAt: last.t, source: 'cache' };
    }

    setStatus('loading', 'VERBINDE MIT ADS-B FEED…');

    if (api) {
      api.onUpdate(handleResult);
      api.onAlwaysOnTopChanged(function (value) {
        state.pinned = value;
        el.btnPin.classList.toggle('active', value);
      });
      var last = await api.getLast();
      if (last) handleResult(last);
      else refresh('boot');
    } else {
      refresh('boot');
      setInterval(function () { refresh('timer'); }, CONFIG.refreshIntervalMs);
    }

    setInterval(tickCountdown, 1000);
    tickCountdown();

    /* Bedienelemente */
    el.btnTheme.addEventListener('click', toggleTheme);
    el.btnRefresh.addEventListener('click', function () { refresh('manuell'); });
    el.btnPin.addEventListener('click', function () {
      if (api) api.toggleAlwaysOnTop();
    });
    el.btnMin.addEventListener('click', function () { if (api) api.minimize(); });
    el.btnClose.addEventListener('click', function () { if (api) api.close(); else window.close(); });

    document.addEventListener('keydown', function (evt) {
      if (evt.key === 't' || evt.key === 'T') toggleTheme();
      if (evt.key === 'r' || evt.key === 'R') refresh('tastatur');
      if (evt.key === 'p' || evt.key === 'P') { if (api) api.toggleAlwaysOnTop(); }
      if (evt.key === 'f' || evt.key === 'F') { userMovedMap = false; fitRoute(); }
      if (evt.key === 'Escape' && api) api.close();
    });

    window.addEventListener('resize', applyResponsiveClasses);
    applyResponsiveClasses();
  }

  // Fuer Tests aus der Konsole / aus dem Smoke-Test heraus
  window.__ek = { state: state, render: render, refresh: refresh, setTheme: setTheme, deadReckon: deadReckon };

  document.addEventListener('DOMContentLoaded', boot);
})();
