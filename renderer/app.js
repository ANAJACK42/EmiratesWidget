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
    fix: null,
    routeIndex: 0,
    sim: true,
    source: null,
    loading: false,
    pinned: true
  };

  var el = {};
  ['identFlight','identCallsign','identOrigin','identDest','btnTheme','btnRefresh','btnPin','btnMin','btnClose',
   'statusLed','statusText','statusSource','statusNext','ovlPos','ovlGs','ovlTas','ovlWind',
   'ovlWindArrow','ovlTo','ovlBrg','ovlRemain','ovlEta','ovlRange','ovlMode',
   'progOrigin','progDest','progFlown','progRemaining','progPct','progFill','progMarker',
   'valGs','subGs','valAlt','subAlt','valTrk','subTrk','valVs','subVs','valPos','subPos',
   'valMach','subMach','valEta','subEta','valAcft','subAcft','footerLeft','footerRight','shell',
   'btnDiag','diag','diagText','csForm','csInput','statusAge','btnSim']
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

  /* ---------- Route ---------- */

  /* Die Route wird zwischen den Stützpunkten auf Grosskreisstuecke verdichtet,
     damit Entfernungen entlang der Strecke gemessen werden koennen und die
     Linie auf der Karte richtig gekruemmt liegt. */
  var route = { points: [], cumulative: [], totalNm: 0, source: 'geplant' };

  function buildRoute(waypoints) {
    var points = [];
    var i, from, to, segments, gc, j;
    for (i = 1; i < waypoints.length; i += 1) {
      from = { lat: waypoints[i - 1][0], lon: waypoints[i - 1][1] };
      to = { lat: waypoints[i][0], lon: waypoints[i][1] };
      segments = Math.max(2, Math.ceil(GEO.distanceNm(from, to) / 40));
      gc = GEO.greatCircle(from, to, segments);
      for (j = (i === 1 ? 0 : 1); j < gc.length; j += 1) points.push(gc[j]);
    }
    var cumulative = [0];
    for (i = 1; i < points.length; i += 1) {
      cumulative[i] = cumulative[i - 1] + GEO.distanceNm(points[i - 1], points[i]);
    }
    return { points: points, cumulative: cumulative, totalNm: cumulative[cumulative.length - 1] || 0 };
  }

  /* Index des Routenpunktes, der der Position am naechsten liegt */
  function nearestRouteIndex(pos) {
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i < route.points.length; i += 1) {
      var d = GEO.distanceNm(pos, route.points[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return { index: best, offRouteNm: bestDist };
  }

  /* Entfernungen entlang der Route statt Luftlinie */
  function routeProgress(pos, predicted) {
    // Liegt eine gemessene Spur vor, ist die zurückgelegte Strecke bekannt und
    // die verbleibende ergibt sich aus dem vorausberechneten Weg.
    if (predicted && predicted.lengthNm && state.trackLengthNm) {
      var flownNm = state.trackLengthNm + GEO.distanceNm(state.trackEnd || pos, pos);
      var total = flownNm + predicted.lengthNm;
      return {
        flownNm: flownNm, remainingNm: predicted.lengthNm, totalNm: total,
        offRouteNm: 0, index: 0
      };
    }
    return routeProgressAlongRoute(pos);
  }

  function routeProgressAlongRoute(pos) {
    if (!route.points.length) {
      var direct = GEO.distanceNm(CONFIG.origin, CONFIG.destination);
      return {
        flownNm: GEO.distanceNm(CONFIG.origin, pos),
        remainingNm: GEO.distanceNm(pos, CONFIG.destination),
        totalNm: direct, offRouteNm: 0, index: 0
      };
    }
    var near = nearestRouteIndex(pos);
    // Einmal passierte Punkte bleiben passiert – sonst springt die Anzeige
    if (state.routeIndex && near.index < state.routeIndex && near.offRouteNm < 60) {
      near.index = state.routeIndex;
    } else {
      state.routeIndex = near.index;
    }
    /* Gemessen wird auf den nächsten VORAUS liegenden Punkt. Auf den
       nächstgelegenen zu messen ließe die Restdistanz wachsen, sobald das
       Flugzeug einen Punkt hinter sich lässt. */
    var ahead = Math.min(near.index + 1, route.points.length - 1);
    var toAhead = GEO.distanceNm(pos, route.points[ahead]);
    var remaining = toAhead + (route.totalNm - route.cumulative[ahead]);
    return {
      flownNm: Math.max(0, route.totalNm - remaining),
      remainingNm: Math.max(0, remaining),
      totalNm: route.totalNm,
      offRouteNm: near.offRouteNm,
      index: near.index
    };
  }

  /* Vorausberechneter Weg zum Ziel.
     Ein Flugzeug springt nicht auf den Direktkurs, es dreht mit begrenzter
     Rate ein. Der Weg beginnt deshalb tangential zur aktuellen Flugrichtung
     und schwenkt über einige hundert Meilen zum Ziel – das ergibt den Bogen,
     der auch tatsächlich geflogen wird. */
  var PREDICT_STEP_NM = 25;
  var PREDICT_TURN_PER_STEP = 3.2; // Grad je Teilstück

  function predictedPath(ac) {
    if (!ac || !isNum(ac.lat) || !isNum(ac.lon)) return [];
    var pos = { lat: ac.lat, lon: ac.lon };
    var heading = isNum(ac.trackDeg) ? ac.trackDeg : GEO.bearingDeg(pos, CONFIG.destination);
    var points = [pos];
    var lengthNm = 0;
    for (var i = 0; i < 300; i += 1) {
      var toDest = GEO.distanceNm(pos, CONFIG.destination);
      if (toDest <= PREDICT_STEP_NM) {
        points.push({ lat: CONFIG.destination.lat, lon: CONFIG.destination.lon });
        lengthNm += toDest;
        break;
      }
      var bearing = GEO.bearingDeg(pos, CONFIG.destination);
      var diff = ((bearing - heading + 540) % 360) - 180;
      heading = (heading + Math.max(-PREDICT_TURN_PER_STEP, Math.min(PREDICT_TURN_PER_STEP, diff)) + 360) % 360;
      pos = GEO.destination(pos, heading, PREDICT_STEP_NM);
      points.push(pos);
      lengthNm += PREDICT_STEP_NM;
    }
    points.lengthNm = lengthNm;
    return points;
  }

  /* ---------- Karte ---------- */

  var map = null;
  var layers = {};

  /* Die Karte kommt ohne Kachel-Server und ohne API-Schluessel aus:
     Kuestenlinien und Grenzen liegen als Vektordaten in renderer/world.js
     (Natural Earth, Public Domain) direkt bei. */
  var COLORS = {
    ecam: {
      background: '#04100c',
      land: 'rgba(0, 255, 150, 0.07)', coast: '#00c878', border: 'rgba(0, 255, 150, 0.3)',
      grid: 'rgba(0, 255, 150, 0.12)', ring: 'rgba(0, 208, 255, 0.38)',
      plan: 'rgba(255, 255, 255, 0.28)', flown: '#00ff66', remaining: '#00ff66', acft: '#ffffff'
    },
    glass: {
      background: '#141b2b',
      land: 'rgba(255, 255, 255, 0.14)', coast: 'rgba(255, 255, 255, 0.5)', border: 'rgba(255, 255, 255, 0.22)',
      grid: 'rgba(255, 255, 255, 0.09)', ring: 'rgba(255, 255, 255, 0.3)',
      plan: 'rgba(255,255,255,0.35)', flown: '#7ec8ff', remaining: 'rgba(190,140,255,0.9)', acft: '#ffffff'
    }
  };

  /* Gradnetz alle 10 Grad - wie auf einem Navigationsdisplay */
  function graticule() {
    var lines = [];
    var lat, lon, line;
    for (lat = -80; lat <= 80; lat += 10) {
      line = [];
      for (lon = -180; lon <= 180; lon += 10) line.push([lat, lon]);
      lines.push(line);
    }
    for (lon = -180; lon <= 180; lon += 10) {
      line = [];
      for (lat = -80; lat <= 80; lat += 10) line.push([lat, lon]);
      lines.push(line);
    }
    return lines;
  }

  function airportMarker(apt, label, kind) {
    return L.marker([apt.lat, apt.lon], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'apt-marker apt-' + kind,
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
    if (typeof L === 'undefined') {
      // Kartenbibliothek nicht geladen (z. B. CDN blockiert): Rest läuft weiter
      document.getElementById('map').innerHTML =
        '<div style="display:flex;height:100%;align-items:center;justify-content:center;' +
        'text-align:center;padding:16px;font-size:11px;opacity:.8">KARTE NICHT VERFUEGBAR<br>' +
        'Kartenbibliothek konnte nicht geladen werden.<br>Instrumente laufen weiter.</div>';
      return false;
    }
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: false,
      preferCanvas: true,
      minZoom: 2,
      maxZoom: 9
    });
    map.setView([37, 33], 4);
    map.attributionControl.setPrefix('');
    map.attributionControl.addAttribution('Karte: Natural Earth');

    var world = window.EK_WORLD || { land: null, borders: null };
    layers.grid = L.polyline(graticule(), { color: COLORS.ecam.grid, weight: 0.5, interactive: false }).addTo(map);
    if (world.land) {
      layers.land = L.geoJSON(world.land, {
        interactive: false,
        style: { fillColor: COLORS.ecam.land, fillOpacity: 1, color: COLORS.ecam.coast, weight: 1 }
      }).addTo(map);
    }
    if (world.borders) {
      layers.borders = L.geoJSON(world.borders, {
        interactive: false,
        style: { color: COLORS.ecam.border, weight: 0.6, fill: false, dashArray: '3 4' }
      }).addTo(map);
    }

    layers.plan = L.polyline([], { color: COLORS.ecam.plan, weight: 1, opacity: 0.9, dashArray: '2 6' }).addTo(map);
    layers.remaining = L.polyline([], { color: COLORS.ecam.remaining, weight: 1.6, opacity: 0.85, dashArray: '10 8' }).addTo(map);
    layers.flown = L.polyline([], { color: COLORS.ecam.flown, weight: 2.5, opacity: 1 }).addTo(map);
    layers.origin = airportMarker(CONFIG.origin, CONFIG.origin.iata, 'origin').addTo(map);
    layers.destination = airportMarker(CONFIG.destination, CONFIG.destination.iata, 'dest').addTo(map);
    // Äußerer Entfernungsring als Maßstab, dazu die Puls-Ebene
    layers.rangeOuter = L.circle([CONFIG.origin.lat, CONFIG.origin.lon], {
      radius: 0, fill: false, color: COLORS.ecam.ring, weight: 1, dashArray: '5 7', interactive: false
    }).addTo(map);
    layers.pulses = L.layerGroup().addTo(map);

    layers.aircraft = L.marker([CONFIG.origin.lat, CONFIG.origin.lon], {
      icon: aircraftIcon(0), interactive: false, keyboard: false, zIndexOffset: 1000,
      opacity: 0 // erst sichtbar, sobald eine echte Position vorliegt
    });

    buildCityLayer();
    applyThemeToMap();
    layers.plan.setLatLngs(route.points.map(toLatLng));
    drawWaypoints();
    fitRoute();
    return true;
  }

  function toLatLng(p) { return [p.lat, p.lon]; }

  function applyThemeToMap() {
    if (!map) return;
    var c = COLORS[state.theme];
    document.getElementById('map').style.background = c.background;
    if (layers.grid) layers.grid.setStyle({ color: c.grid });
    if (layers.land) layers.land.setStyle({ fillColor: c.land, color: c.coast });
    if (layers.borders) layers.borders.setStyle({ color: c.border });
    if (layers.rangeOuter) layers.rangeOuter.setStyle({ color: c.ring });
    layers.plan.setStyle({ color: c.plan });
    layers.flown.setStyle({ color: c.flown });
    layers.remaining.setStyle({ color: c.remaining });
    if (state.aircraft) layers.aircraft.setIcon(aircraftIcon(state.aircraft.trackDeg || 0));
  }

  /* Städte als Orientierungspunkte; Dichte haengt an der Zoomstufe. */
  function buildCityLayer() {
    // Städte direkt an Start und Ziel weglassen – dort steht schon die Flughafenmarke
    var cities = (window.EK_CITIES || []).filter(function (city) {
      var p = { lat: city[1], lon: city[2] };
      return GEO.distanceNm(p, CONFIG.origin) > 25 && GEO.distanceNm(p, CONFIG.destination) > 25;
    });
    layers.cities = L.layerGroup().addTo(map);
    layers.cityMarkers = cities.map(function (city) {
      return {
        rank: city[3],
        marker: L.marker([city[1], city[2]], {
          interactive: false, keyboard: false,
          icon: L.divIcon({
            className: 'city-marker',
            html: '<span class="city-dot"></span><span class="city-name">' + city[0] + '</span>',
            iconSize: [4, 4], iconAnchor: [2, 2]
          })
        })
      };
    });
    map.on('zoomend', updateCityLayer);
    updateCityLayer();
  }

  function updateCityLayer() {
    if (!layers.cityMarkers) return;
    var zoom = map.getZoom();
    // Wegpunktnamen erst bei genügend Zoom, sonst nur die Rauten
    document.getElementById('map').classList.toggle('labels-off', zoom < 5);
    var maxRank = zoom >= 6 ? 3 : zoom >= 4 ? 2 : zoom >= 3 ? 1 : 0;
    layers.cityMarkers.forEach(function (entry) {
      var visible = entry.rank <= maxRank;
      if (visible && !layers.cities.hasLayer(entry.marker)) layers.cities.addLayer(entry.marker);
      if (!visible && layers.cities.hasLayer(entry.marker)) layers.cities.removeLayer(entry.marker);
    });
  }

  /* Wegpunkte der Route wie auf einem Navigationsdisplay */
  function drawWaypoints() {
    if (!CONFIG.plannedRoute || !route.isPlanned) return;
    layers.waypoints = L.layerGroup().addTo(map);
    CONFIG.plannedRoute.forEach(function (wp, index) {
      if (index === 0 || index === CONFIG.plannedRoute.length - 1) return; // Start und Ziel haben eigene Marken
      layers.waypoints.addLayer(L.marker([wp[0], wp[1]], {
        interactive: false, keyboard: false,
        icon: L.divIcon({
          className: 'wp-marker',
          html: '<span class="wp-cross">◇</span><span class="wp-name">' + wp[2] + '</span>',
          iconSize: [8, 8], iconAnchor: [4, 4]
        })
      }));
    });
  }

  var userMovedMap = false;
  function fitRoute() {
    if (!map || userMovedMap) return;
    var pts = [toLatLng(CONFIG.origin), toLatLng(CONFIG.destination)];
    if (state.aircraft) pts.push([state.aircraft.lat, state.aircraft.lon]);
    map.fitBounds(L.latLngBounds(pts).pad(0.18), { animate: false });
  }

  /* Auf einem Navigationsdisplay ist die Reichweite eine feste Stufe.
     Passende Stufe zur aktuellen Kartenausdehnung waehlen und Ringe setzen. */
  var ND_RANGES = [10, 20, 40, 80, 160, 320, 640];

  function updateRangeRings(ac) {
    var center = map.getCenter();
    var north = map.getBounds().getNorth();
    var spanNm = GEO.distanceNm({ lat: center.lat, lon: center.lng }, { lat: north, lon: center.lng });
    var range = ND_RANGES[ND_RANGES.length - 1];
    for (var i = 0; i < ND_RANGES.length; i += 1) {
      if (ND_RANGES[i] >= spanNm * 0.85) { range = ND_RANGES[i]; break; }
    }
    var metersPerNm = 1852;
    layers.rangeOuter.setLatLng([ac.lat, ac.lon]).setRadius(range * metersPerNm);
    state.pulseRadiusM = (range / 2) * metersPerNm; // Puls verlischt am inneren Ring
    state.pulseCenter = [ac.lat, ac.lon];
    el.ovlRange.textContent = range + ' NM';
  }

  function drawFlight(ac) {
    if (!map) return;
    var flown = state.track.map(toLatLng);
    // Fuer den Abschnitt vor dem ersten aufgezeichneten Punkt der Route folgen,
    // nicht quer ueber die Karte schneiden.
    var head = state.track.length ? state.track[0] : ac;
    var lead;
    if (route.points.length) {
      var headNear = nearestRouteIndex(head);
      lead = route.points.slice(0, Math.max(1, headNear.index + 1)).map(toLatLng);
      if (headNear.offRouteNm > 200) lead = GEO.greatCircle(CONFIG.origin, head, 48).map(toLatLng);
    } else {
      lead = GEO.greatCircle(CONFIG.origin, head, 48).map(toLatLng);
    }
    layers.flown.setLatLngs(lead.concat(flown));
    // Restweg: Bogen, der an der aktuellen Flugrichtung ansetzt
    var predicted = state.predicted && state.predicted.length ? state.predicted : predictedPath(ac);
    layers.remaining.setLatLngs(predicted.map(toLatLng));
    if (!map.hasLayer(layers.aircraft)) layers.aircraft.addTo(map);
    layers.aircraft.setOpacity(1);
    layers.aircraft.setLatLng([ac.lat, ac.lon]);
    layers.aircraft.setIcon(aircraftIcon(ac.trackDeg || GEO.bearingDeg(ac, CONFIG.destination)));
    fitRoute();
    updateRangeRings(ac);
  }

  /* ---------- Anzeige ---------- */

  function setStatus(kind, text) {
    el.statusLed.className = 'status-led ' + kind;
    el.statusText.textContent = text;
    // Airbus-Logik: Amber = Vorsicht, Rot = Warnung
    el.statusText.classList.toggle('caution', kind === 'stale');
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
    // Entfernungen entlang der tatsaechlichen Route, nicht Luftlinie
    state.predicted = predictedPath(ac);
    var prog = routeProgress(ac, state.predicted);
    var totalNm = prog.totalNm;
    var flownNm = prog.flownNm;
    var remainNm = prog.remainingNm;
    var pct = totalNm > 0 ? Math.min(100, Math.max(0, (flownNm / totalNm) * 100)) : 0;
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
    } else if (ac.extrapolatedSec > 15) {
      // Zwischen zwei Positionen: fortgeschrieben, nicht gemessen
      setStatus('live', 'IM FLUG · KOPPELNAV +' + Math.round(ac.extrapolatedSec / 60) + ' MIN'
        + (ac.simulated ? ' · SIM' : ''));
    } else {
      setStatus('live', 'IM FLUG · POSITION EMPFANGEN' + (ac.simulated ? ' · SIM' : ''));
    }
    el.statusSource.textContent = 'SRC ' + String(ac.source || '—').toUpperCase();

    /* Karten-Overlays im Stil eines Navigationsdisplays */
    el.ovlPos.textContent = GEO.formatLat(ac.lat) + ' ' + GEO.formatLon(ac.lon);
    el.ovlGs.textContent = gs !== null ? Math.round(gs) : '---';
    el.ovlTas.textContent = isNum(ac.trueAirSpeedKt) ? Math.round(ac.trueAirSpeedKt) : '---';

    // Windpfeil zeigt in die Richtung, in die der Wind weht (Airbus-Konvention)
    if (isNum(ac.windDirDeg) && isNum(ac.windSpeedKt)) {
      el.ovlWind.textContent = pad(Math.round(ac.windDirDeg), 3) + '°/' + Math.round(ac.windSpeedKt);
      el.ovlWindArrow.style.transform = 'rotate(' + ((ac.windDirDeg + 180) % 360) + 'deg)';
      el.ovlWindArrow.style.visibility = 'visible';
    } else {
      el.ovlWind.textContent = '---°/--';
      el.ovlWindArrow.style.visibility = 'hidden';
    }

    el.ovlTo.textContent = CONFIG.destination.iata;
    el.ovlBrg.textContent = pad(Math.round(GEO.bearingDeg(ac, CONFIG.destination)), 3) + '°';
    el.ovlRemain.textContent = Math.round(remainNm) + ' NM';
    el.ovlEta.textContent = etaDate ? timeIn(CONFIG.destination.tz, etaDate) : '--:--';

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
    var vsDerived = false;
    if (vs === null) {
      var derived = derivedVerticalSpeed();
      if (derived) { vs = derived.value; vsDerived = true; }
    }
    el.valVs.textContent = vs !== null ? (vs > 0 ? '+' + vs : String(vs)) : '---';
    el.subVs.textContent = vs === null ? '—'
      : (vs > 200 ? 'STEIGFLUG' : vs < -200 ? 'SINKFLUG' : 'REISEFLUG') + (vsDerived ? ' (BER)' : '');

    el.valPos.textContent = GEO.formatLat(ac.lat);
    el.subPos.textContent = GEO.formatLon(ac.lon) + (ac.extrapolatedSec ? ' · DR' : '');

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
    el.footerRight.textContent = 'v' + (CONFIG.version || '?') + ' · UPD ' + utcTime(now) + ' · ' + timeIn(CONFIG.origin.tz, now) + ' MUC · ' + timeIn(CONFIG.destination.tz, now) + ' DXB';

    drawFlight(ac);
  }

  /* ---------- Laufende Bewegung zwischen zwei Aktualisierungen ----------
     Die Quelle liefert alle paar Minuten eine Position. Dazwischen wird
     fortgeschrieben, was sich physikalisch zwingend ergibt: Aus Kurs und
     Geschwindigkeit folgt die Position, daraus Restdistanz, Fortschritt und
     ETA. Das ist gerechnet, nicht gemessen, und wird als DR gekennzeichnet
     (dead reckoning – dasselbe Verfahren nutzt die Navigation an Bord). */

  function extrapolate(fix) {
    if (!fix || !isNum(fix.groundSpeedKt) || !isNum(fix.trackDeg)) return fix;
    var seconds = (Date.now() - fix.observedAt) / 1000;
    if (seconds < 5) return fix;
    var nm = fix.groundSpeedKt * (seconds / 3600);
    var toDest = GEO.distanceNm(fix, CONFIG.destination);
    var moved = GEO.destination(fix, fix.trackDeg, Math.min(nm, Math.max(0, toDest - 1)));
    var out = Object.assign({}, fix, { lat: moved.lat, lon: moved.lon, extrapolatedSec: Math.round(seconds) });

    // Sinkflug ab etwa 130 NM vor dem Ziel annehmen
    if (isNum(out.altitudeFt) && toDest < 130 && out.altitudeFt > 5000) {
      out.altitudeFt = Math.max(3000, Math.round(out.altitudeFt - (nm * 250)));
    }
    return out;
  }

  /* Steig-/Sinkrate aus der aufgezeichneten Spur ableiten, wenn die Quelle
     keine liefert – der wahrscheinlichste Wert ist die Höhenänderung der
     letzten Minuten. */
  function derivedVerticalSpeed() {
    var track = state.track;
    if (!track || track.length < 2) return null;
    var last = track[track.length - 1];
    if (!isNum(last.alt)) return null;
    for (var i = track.length - 2; i >= 0; i -= 1) {
      var p = track[i];
      if (!isNum(p.alt)) continue;
      var minutes = (last.t - p.t) / 60000;
      if (minutes < 0.5) continue;         // zu kurz: Rauschen
      if (minutes > 8) break;              // zu lang: nicht mehr aktuell
      var fpm = (last.alt - p.alt) / minutes;
      return { value: Math.round(fpm / 50) * 50, minutes: minutes };
    }
    return { value: 0, minutes: 0 };
  }

  /* Optionale Sichtbarkeitshilfe: minimales Schwanken um die gemessenen Werte,
     damit erkennbar bleibt, dass die Anzeige lebt. Wird als SIM ausgewiesen
     und lässt sich abschalten. */
  var SIM_KEY = 'ek050.sim';

  function applyJitter(ac) {
    if (!state.sim || !ac) return ac;
    var t = Date.now() / 1000;
    var out = Object.assign({}, ac);
    if (isNum(out.groundSpeedKt)) out.groundSpeedKt = out.groundSpeedKt + Math.sin(t / 7) * 2.5 + Math.sin(t / 3.1) * 1.2;
    if (isNum(out.altitudeFt) && out.altitudeFt > 10000) out.altitudeFt = out.altitudeFt + Math.round(Math.sin(t / 11) * 40 / 25) * 25;
    if (isNum(out.trackDeg)) out.trackDeg = (out.trackDeg + Math.sin(t / 13) * 0.8 + 360) % 360;
    out.simulated = true;
    return out;
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

  /* --- Quellen und Ausweichwege ------------------------------------
     Im Browser blockiert die Same-Origin-Regel eine Quelle, sobald diese
     keine CORS-Kopfzeile schickt. Deshalb: erst direkt, dann über
     öffentliche CORS-Weiterleitungen. Jeder Versuch wird protokolliert und
     ist über den DIAG-Knopf sichtbar. */
  var CALLSIGN_KEY = 'ek050.callsign';

  function activeCallsign() {
    return state.callsign || CONFIG.callsign;
  }

  function sourcesFor(callsign) {
    var list = [
      { name: 'adsb.lol ' + callsign, url: 'https://api.adsb.lol/v2/callsign/' + callsign },
      { name: 'adsb.fi ' + callsign, url: 'https://opendata.adsb.fi/api/v2/callsign/' + callsign },
      { name: 'airplanes.live ' + callsign, url: 'https://api.airplanes.live/v2/callsign/' + callsign }
    ];
    // Danach die bekannten Schreibvarianten durchprobieren (z. B. UAE50 statt UAE5T)
    CONFIG.callsignVariants.forEach(function (variant) {
      var v = variant.toUpperCase();
      if (v === callsign.toUpperCase()) return;
      list.push({ name: 'adsb.lol ' + v, url: 'https://api.adsb.lol/v2/callsign/' + v });
    });
    return list;
  }

  var PROXIES = [
    { name: 'allorigins', wrap: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { name: 'codetabs', wrap: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } },
    { name: 'corsproxy.io', wrap: function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); } },
    { name: 'isomorphic', wrap: function (u) { return 'https://cors.isomorphic-git.org/' + u; } }
  ];

  function fetchJson(url, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 12000) : null;
    return fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        try { return JSON.parse(text); }
        catch (err) { throw new Error('kein JSON (' + text.slice(0, 40) + ')'); }
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  /* Antwort der readsb-Feeds in unser Format bringen */
  function mapAircraft(json, sourceLabel) {
    var list = (json && (json.ac || json.aircraft)) || [];
    if (!Array.isArray(list) || !list.length) return null;
    var active = activeCallsign().toUpperCase().replace(/[^A-Z0-9]/g, '');
    var variants = CONFIG.callsignVariants.concat([active, active.replace(/^(\D+)/, '$10')]);
    var wanted = list.filter(function (a) {
      var cs = String(a.flight || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return variants.some(function (v) { return v.toUpperCase().replace(/[^A-Z0-9]/g, '') === cs; });
    });
    var a = (wanted.length ? wanted : list)[0];
    var lat = Number(a.lat), lon = Number(a.lon);
    if (!isNum(lat) || !isNum(lon)) return null;
    var onGround = a.alt_baro === 'ground';
    return {
      source: sourceLabel, icao24: a.hex || null, callsign: (a.flight || '').trim() || CONFIG.callsign,
      registration: a.r || null, aircraftType: a.t || null, lat: lat, lon: lon,
      altitudeFt: onGround ? 0 : Number(a.alt_baro), geoAltitudeFt: Number(a.alt_geom),
      groundSpeedKt: Number(a.gs), trueAirSpeedKt: Number(a.tas), indicatedAirSpeedKt: Number(a.ias),
      mach: Number(a.mach), trackDeg: isNum(Number(a.track)) ? Number(a.track) : Number(a.true_heading),
      headingDeg: Number(a.true_heading), verticalRateFpm: isNum(Number(a.baro_rate)) ? Number(a.baro_rate) : Number(a.geom_rate),
      squawk: a.squawk || null, windDirDeg: Number(a.wd), windSpeedKt: Number(a.ws),
      outsideAirTempC: Number(a.oat), onGround: onGround,
      positionAgeSec: isNum(Number(a.seen_pos)) ? Number(a.seen_pos) : Number(a.seen),
      observedAt: Date.now()
    };
  }

  async function tryUrl(url, label, attempts) {
    try {
      var json = await fetchJson(url, 8000);
      var aircraft = mapAircraft(json, label);
      if (aircraft) { attempts.push({ label: label, status: 'OK' }); return aircraft; }
      attempts.push({ label: label, status: 'antwortet, kein Treffer' });
    } catch (err) {
      var msg = String((err && err.message) || err);
      if (msg === 'Failed to fetch' || /NetworkError|abort/i.test(msg)) msg = 'blockiert/CORS oder Zeitüberschreitung';
      attempts.push({ label: label, status: msg });
    }
    return null;
  }

  /* Wenn das Rufzeichen nichts findet: den Korridor absuchen und alle
     Emirates-Flüge melden, die dort gerade unterwegs sind. So wird sichtbar,
     ob die Feeds arbeiten und unter welcher Nummer sie tatsächlich fliegt. */
  async function scanCorridor() {
    var probes = [[46.2, 14.5], [36.4, 23.6], [30.0, 31.2], [24.6, 34.6], [24.7, 46.7], [25.3, 53.0]];
    var found = {};
    setStatus('loading', 'SUCHE EMIRATES-FLUEGE AUF DER STRECKE…');
    await Promise.all(probes.map(function (probe) {
      return fetchJson('https://api.adsb.lol/v2/point/' + probe[0] + '/' + probe[1] + '/250', 8000)
        .then(function (json) {
          ((json && json.ac) || []).forEach(function (a) {
            var cs = String(a.flight || '').trim().toUpperCase();
            if (cs.indexOf('UAE') !== 0) return;
            found[cs] = {
              callsign: cs, registration: a.r || '', type: a.t || '',
              lat: Number(a.lat), lon: Number(a.lon), track: Number(a.track), altitude: a.alt_baro
            };
          });
        })
        .catch(function () { /* dieser Punkt liefert nichts */ });
    }));
    return Object.keys(found).map(function (k) { return found[k]; });
  }

  /* Alle Anfragen einer Stufe laufen gleichzeitig; die erste brauchbare
     Antwort gewinnt. Nacheinander waere es im schlechtesten Fall minutenlang. */
  function firstSuccess(tasks) {
    return new Promise(function (resolve) {
      var pending = tasks.length;
      var settled = false;
      if (!pending) { resolve(null); return; }
      tasks.forEach(function (task) {
        task().then(function (result) {
          if (result && !settled) { settled = true; resolve(result); }
        }, function () { /* Fehler stehen schon im Protokoll */ })
          .then(function () {
            pending -= 1;
            if (pending === 0 && !settled) { settled = true; resolve(null); }
          });
      });
    });
  }

  /* Von GitHub Actions serverseitig geholte Daten, ausgeliefert von derselben
     Adresse wie die Seite: keine CORS-Grenzen, keine Drosselung, funktioniert
     auch in Netzen, die die ADS-B-Dienste blockieren. */
  /* Zwei Wege zu denselben Daten: neben der eigenen Adresse auch direkt aus
     dem Repository. Letzteres funktioniert auch in der Einzeldatei und wenn
     GitHub Pages gerade neu baut. */
  var RELAY_BASE = 'https://raw.githubusercontent.com/ANAJACK42/EmiratesWidget/' +
    'claude/ek050-flight-tracker-widget-ourg9m/';

  async function fetchRelayJson(name, timeoutMs) {
    var urls = ['data/' + name + '?t=' + Date.now(), RELAY_BASE + 'data/' + name + '?t=' + Date.now()];
    var lastError = null;
    for (var i = 0; i < urls.length; i += 1) {
      try {
        return { json: await fetchJson(urls[i], timeoutMs), viaRepo: i > 0 };
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error('nicht erreichbar');
  }

  async function fetchRelay(attempts) {
    try {
      var relay = await fetchRelayJson('flight.json', 8000);
      var json = relay.json;
      var quelle = relay.viaRepo ? 'Repository' : 'eigene Adresse';
      var ageMin = json && json.updatedAt ? (Date.now() - new Date(json.updatedAt).getTime()) / 60000 : 999;
      if (json && json.ok && json.aircraft && ageMin < 20) {
        attempts.push({ label: 'Serverdaten über ' + quelle, status: 'OK, ' + Math.round(ageMin) + ' min alt' });
        var ac = json.aircraft;
        ac.source = (ac.source || 'relay') + ' via Actions';
        ac.observedAt = new Date(json.updatedAt).getTime();
        // Die serverseitig mitgeschriebene Spur ist die tatsächlich geflogene Route
        try {
          var trail = (await fetchRelayJson('track.json', 8000)).json;
          if (Array.isArray(trail) && trail.length > 5) {
            state.track = trail.map(function (p) {
              return { lat: p.lat, lon: p.lon, t: new Date(p.t).getTime(), alt: p.alt, gs: p.gs };
            });
            attempts.push({ label: 'Spur aus dem Repo', status: state.track.length + ' Punkte' });
            routeFromTrack();
          }
        } catch (err) { /* ohne Spur läuft es auch */ }
        return ac;
      }
      attempts.push({
        label: 'Serverdaten über ' + quelle,
        status: json && json.ok ? 'zu alt (' + Math.round(ageMin) + ' min)' : 'kein Treffer im letzten Lauf'
      });
      if (json && json.nearbyEmirates) state.nearby = json.nearbyEmirates;
    } catch (err) {
      attempts.push({ label: 'Serverdaten', status: 'nicht erreichbar: ' + String((err && err.message) || err) });
    }
    return null;
  }

  async function fetchDirect() {
    var attempts = [];
    var aircraft;
    var SOURCES = sourcesFor(activeCallsign());

    // 0. Zuerst die serverseitig geholten Daten
    setStatus('loading', 'ABFRAGE · SERVERDATEN…');
    aircraft = await fetchRelay(attempts);
    if (aircraft) return { ok: true, aircraft: aircraft, attempts: attempts, checkedAt: Date.now() };

    // 1. Alle Quellen direkt, gleichzeitig
    setStatus('loading', 'ABFRAGE · ' + SOURCES.length + ' QUELLEN DIREKT…');
    aircraft = await firstSuccess(SOURCES.map(function (s) {
      return function () { return tryUrl(s.url, s.name, attempts); };
    }));
    if (aircraft) return { ok: true, aircraft: aircraft, attempts: attempts, checkedAt: Date.now() };

    // 2. Dieselben Quellen über CORS-Weiterleitungen, ebenfalls gleichzeitig
    setStatus('loading', 'ABFRAGE · UEBER WEITERLEITUNGEN…');
    var relayTasks = [];
    PROXIES.forEach(function (proxy) {
      SOURCES.slice(0, 3).forEach(function (s) {
        relayTasks.push(function () { return tryUrl(proxy.wrap(s.url), proxy.name + '→' + s.name, attempts); });
      });
    });
    aircraft = await firstSuccess(relayTasks);
    if (aircraft) return { ok: true, aircraft: aircraft, attempts: attempts, checkedAt: Date.now() };

    var answered = attempts.some(function (att) { return att.status === 'antwortet, kein Treffer'; });
    var nearby = [];
    if (answered) {
      // Feeds arbeiten – dann nachsehen, wer sonst unterwegs ist
      try { nearby = await scanCorridor(); } catch (err) { nearby = []; }
    }
    return {
      ok: false, aircraft: null, attempts: attempts, nearby: nearby,
      checkedAt: Date.now(), error: answered ? 'kein-treffer' : 'feeds'
    };
  }

  function renderDiag() {
    var lines = [];
    lines.push('FLUG    ' + CONFIG.flightIata + '  RUFZEICHEN ' + activeCallsign());
    lines.push('STAND   ' + (CONFIG.version || '—'));
    lines.push('ABFRAGE ' + (state.lastCheck ? new Date(state.lastCheck).toLocaleTimeString('de-DE') : '—'));
    lines.push('MODUS   ' + (api ? 'Desktop-App (ohne CORS-Grenzen)' : 'Browser'));
    lines.push('ROUTE   ' + route.source + ' · ' + Math.round(route.totalNm) + ' NM · '
      + (CONFIG.plannedRoute ? CONFIG.plannedRoute.length : 2) + ' Stützpunkte');
    lines.push('');
    lines.push('VERSUCHE:');
    (state.diag || []).forEach(function (att) {
      lines.push('  ' + (att.status === 'OK' ? '✓' : '✗') + ' ' + att.label + ' — ' + att.status);
    });
    if (!(state.diag || []).length) lines.push('  (noch keine)');

    if ((state.nearby || []).length) {
      lines.push('');
      lines.push('EMIRATES-FLUEGE AUF DER STRECKE (aus den Feeds):');
      state.nearby.forEach(function (f) {
        lines.push('  ' + f.callsign.padEnd(8) + (f.registration || '------').padEnd(8) +
          (f.type || '----').padEnd(6) + GEO.formatLat(f.lat) + ' ' + GEO.formatLon(f.lon) +
          '  ' + (f.altitude === 'ground' ? 'AM BODEN' : f.altitude + ' ft'));
      });
      lines.push('');
      lines.push('Passt eine davon? Rufzeichen unten eintragen und übernehmen.');
    }
    el.diagText.textContent = lines.join('\n');
    el.csInput.placeholder = activeCallsign();
  }

  function handleResult(result) {
    state.loading = false;
    state.diag = (result && result.attempts) || [];
    state.lastCheck = (result && result.checkedAt) || Date.now();
    renderDiag();
    el.btnRefresh.classList.remove('active');
    state.nextRefreshAt = (result && result.nextRefreshAt) || Date.now() + CONFIG.refreshIntervalMs;

    if (result && result.ok && result.aircraft) {
      var isNewFix = !state.fix || state.fix.observedAt !== result.aircraft.observedAt;
      state.aircraft = result.aircraft;
      state.lastFix = result.aircraft;
      state.fix = result.aircraft;
      if (isNewFix) {
        // Zähler läuft ab jetzt neu, und die Statuszeile blitzt kurz auf
        el.statusLed.classList.add('flash');
        setTimeout(function () { el.statusLed.classList.remove('flash'); }, 1200);
        tickCountdown();
      }
      if (String(result.aircraft.source || '').indexOf('via Actions') === -1) pushTrackPoint(result.aircraft);
      learnRouteIfArrived(result.aircraft);
      render(result.aircraft, { estimated: false });
      return;
    }

    // Kein Kontakt: letzte bekannte Position fortschreiben
    state.nearby = (result && result.nearby) || [];
    renderDiag();
    var estimate = deadReckon(state.lastFix);
    if (estimate) {
      state.aircraft = estimate;
      render(estimate, { estimated: true });
    } else if (result && result.error === 'kein-treffer') {
      setStatus('stale', 'FEEDS OK · ' + activeCallsign() + ' NICHT IN DER LUFT');
      el.statusSource.textContent = 'SRC —';
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

  /* ---------- Radarpuls ----------
     Alle paar Sekunden geht vom Flugzeug ein Ring aus, wächst bis zum
     Radius des inneren Entfernungsrings und verlischt dabei. */
  var PULSE_INTERVAL_MS = 2600;
  var PULSE_DURATION_MS = 2900;

  function emitPulse() {
    if (!map || !layers.pulses || !state.pulseCenter || !state.pulseRadiusM) return;
    if (document.hidden) return; // im Hintergrund nichts animieren
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var color = COLORS[state.theme].ring;
    var ring = L.circle(state.pulseCenter, {
      radius: 1, fill: false, color: color, weight: 1.4, opacity: 0.75,
      dashArray: '5 7', interactive: false
    }).addTo(layers.pulses);

    var start = performance.now();
    var maxRadius = state.pulseRadiusM;

    function step(now) {
      var t = Math.min(1, (now - start) / PULSE_DURATION_MS);
      // Anfangs schnell, zum Rand hin auslaufend
      var eased = 1 - Math.pow(1 - t, 2);
      ring.setRadius(eased * maxRadius);
      ring.setStyle({ opacity: 0.75 * Math.pow(1 - t, 1.6), weight: 1.4 - t * 0.7 });
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        layers.pulses.removeLayer(ring);
      }
    }
    requestAnimationFrame(step);
  }

  /* ---------- Sekundentakt ---------- */

  /* Einmal pro Sekunde neu zeichnen: Position wird fortgeschrieben,
     Restdistanz, Fortschritt und ETA laufen mit. */
  function tickDisplay() {
    if (!state.fix || state.loading) return;
    var shown = applyJitter(extrapolate(state.fix));
    state.aircraft = shown;
    render(shown, { estimated: false });
  }

  /* ---------- Countdown ---------- */

  function tickCountdown() {
    // Alter der zuletzt empfangenen Position – läuft ab dem Eintreffen neu
    if (state.fix) {
      var age = Math.max(0, Math.round((Date.now() - state.fix.observedAt) / 1000));
      el.statusAge.textContent = 'FIX +' + pad(Math.floor(age / 60)) + ':' + pad(age % 60);
    } else {
      el.statusAge.textContent = 'FIX —';
    }
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
    if (map) applyThemeToMap();
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

  var LEARNED_KEY = 'ek050.route.v1';

  /* Eine früher aufgezeichnete, vollständige Spur ist die exakte Route –
     genauer als jede Schätzung. Sie wird bevorzugt, sobald sie vorliegt. */
  /* Sobald eine echte Spur vorliegt, ist sie die Route: gemessene Punkte bis
     zur aktuellen Position, danach der Direktkurs zum Ziel. Damit stimmen
     Restdistanz, Fortschritt und ETA, statt sich an einer Schätzung zu
     verrechnen. */
  function routeFromTrack() {
    var track = state.track;
    if (!track || track.length < 20) return false;
    // Tatsächlich zurückgelegte Strecke aus der gemessenen Spur
    var flown = 0;
    for (var k = 1; k < track.length; k += 1) flown += GEO.distanceNm(track[k - 1], track[k]);
    state.trackLengthNm = flown;
    state.trackEnd = { lat: track[track.length - 1].lat, lon: track[track.length - 1].lon };
    var step = Math.max(1, Math.floor(track.length / 120));
    var points = [];
    for (var i = 0; i < track.length; i += step) points.push([track[i].lat, track[i].lon, '']);
    var last = track[track.length - 1];
    points.push([last.lat, last.lon, '']);
    points.push([CONFIG.destination.lat, CONFIG.destination.lon, CONFIG.destination.iata]);
    route = buildRoute(points);
    route.source = 'gemessene Spur + Direktkurs (' + track.length + ' Punkte)';
    route.isPlanned = false;
    if (map) {
      layers.plan.setLatLngs(route.points.map(toLatLng));
      if (layers.waypoints) { map.removeLayer(layers.waypoints); layers.waypoints = null; }
    }
    return true;
  }

  function initRoute() {
    var learned = null;
    try { learned = JSON.parse(localStorage.getItem(LEARNED_KEY) || 'null'); } catch (err) { learned = null; }

    if (learned && Array.isArray(learned.points) && learned.points.length > 20) {
      route = buildRoute(learned.points.map(function (p) { return [p[0], p[1], '']; }));
      route.source = 'gelernt (' + (learned.date || 'Vorflug') + ')';
      route.isPlanned = false;
      return;
    }
    route = buildRoute(CONFIG.plannedRoute || [
      [CONFIG.origin.lat, CONFIG.origin.lon, CONFIG.origin.iata],
      [CONFIG.destination.lat, CONFIG.destination.lon, CONFIG.destination.iata]
    ]);
    route.source = 'geplant (südlicher Korridor)';
    route.isPlanned = true;
  }

  /* Am Ende eines Fluges die geflogene Spur als Route sichern */
  function learnRouteIfArrived(ac) {
    if (GEO.distanceNm(ac, CONFIG.destination) > 40) return;
    if (state.track.length < 25) return;
    try {
      localStorage.setItem(LEARNED_KEY, JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        points: state.track.map(function (p) { return [Math.round(p.lat * 1000) / 1000, Math.round(p.lon * 1000) / 1000]; })
      }));
    } catch (err) { /* nicht kritisch */ }
  }

  async function boot() {
    el.identFlight.textContent = CONFIG.flightIata;
    el.identCallsign.textContent = CONFIG.callsign;
    el.identOrigin.textContent = CONFIG.origin.iata;
    el.identDest.textContent = CONFIG.destination.iata;
    el.progOrigin.textContent = CONFIG.origin.iata;
    el.progDest.textContent = CONFIG.destination.iata;

    try { state.callsign = localStorage.getItem(CALLSIGN_KEY) || null; } catch (err) { state.callsign = null; }
    if (state.callsign) el.identCallsign.textContent = state.callsign;

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
    initRoute();
    if (initMap()) {
      map.on('zoomstart dragstart', function () { userMovedMap = true; });
      // Doppelklick auf die Karte: Automatik-Zoom wieder aktivieren
      map.on('dblclick', function () { userMovedMap = false; fitRoute(); });
    }

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
    setInterval(tickDisplay, 1000);
    setInterval(emitPulse, PULSE_INTERVAL_MS);
    tickCountdown();

    try { state.sim = localStorage.getItem(SIM_KEY) !== 'aus'; } catch (err) { state.sim = true; }
    el.btnSim.classList.toggle('active', state.sim);
    el.btnSim.addEventListener('click', function () {
      state.sim = !state.sim;
      try { localStorage.setItem(SIM_KEY, state.sim ? 'an' : 'aus'); } catch (err) {}
      el.btnSim.classList.toggle('active', state.sim);
      tickDisplay();
    });

    /* Bedienelemente */
    el.btnTheme.addEventListener('click', toggleTheme);
    el.btnRefresh.addEventListener('click', function () { refresh('manuell'); });
    el.csForm.addEventListener('submit', function (evt) {
      evt.preventDefault();
      var value = el.csInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!value) return;
      // Eingaben wie "EK50" in das Funkrufzeichen "UAE50" übersetzen
      if (/^EK\d+$/.test(value)) value = 'UAE' + value.slice(2).replace(/^0+/, '');
      state.callsign = value;
      try { localStorage.setItem(CALLSIGN_KEY, value); } catch (err) {}
      el.identCallsign.textContent = value;
      el.csInput.value = '';
      refresh('rufzeichen');
    });

    el.btnDiag.addEventListener('click', function () {
      var open = el.diag.hasAttribute('hidden');
      if (open) { el.diag.removeAttribute('hidden'); renderDiag(); } else { el.diag.setAttribute('hidden', ''); }
      el.btnDiag.classList.toggle('active', open);
      if (map) setTimeout(function () { map.invalidateSize({ animate: false }); }, 0);
    });
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
      if (evt.key === 'd' || evt.key === 'D') el.btnDiag.click();
      if (evt.key === 's' || evt.key === 'S') el.btnSim.click();
      if (evt.key === 'Escape' && api) api.close();
    });

    window.addEventListener('resize', applyResponsiveClasses);
    applyResponsiveClasses();
  }

  // Fuer Tests aus der Konsole / aus dem Smoke-Test heraus
  window.__ek = {
    state: state, render: render, refresh: refresh, setTheme: setTheme, deadReckon: deadReckon,
    // für Tests und Fehlersuche
    getMap: function () { return map; },
    getLayers: function () { return layers; },
    predictedPath: predictedPath,
    emitPulse: function () { emitPulse(); }
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
