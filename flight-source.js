/*
 * Datenbeschaffung fuer EK050.
 *
 * Laeuft im Electron-Main-Prozess (Node), damit weder CORS noch
 * Browser-Sicherheitsregeln die oeffentlichen ADS-B-Feeds blockieren.
 *
 * Es werden mehrere kostenlose, oeffentliche Quellen der Reihe nach
 * abgefragt; die erste brauchbare Antwort gewinnt.
 */
const https = require('https');
const { URL } = require('url');
const CONFIG = require('./config');

const USER_AGENT = 'EK050-Flight-Widget/1.0 (personal use)';

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // Schutz gegen ausufernde Antworten (z. B. OpenSky ohne Bounding-Box)
          if (body.length > 40 * 1024 * 1024) {
            req.destroy(new Error('Antwort zu gross'));
          }
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('Ungueltiges JSON: ' + err.message));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout nach ' + timeoutMs + ' ms')));
    req.on('error', reject);
    req.end();
  });
}

function normalizeCallsign(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function callsignMatches(value) {
  const cs = normalizeCallsign(value);
  if (!cs) return false;
  return CONFIG.callsignVariants.some((v) => normalizeCallsign(v) === cs);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* Antwortformat der readsb-basierten Feeds (adsb.lol, adsb.fi, airplanes.live) */
function mapReadsbAircraft(ac, sourceLabel) {
  const onGround = ac.alt_baro === 'ground';
  const lat = num(ac.lat);
  const lon = num(ac.lon);
  if (lat === null || lon === null) return null;
  return {
    source: sourceLabel,
    icao24: ac.hex || null,
    callsign: (ac.flight || '').trim() || CONFIG.callsign,
    registration: ac.r || null,
    aircraftType: ac.t || null,
    lat,
    lon,
    altitudeFt: onGround ? 0 : num(ac.alt_baro),
    geoAltitudeFt: num(ac.alt_geom),
    groundSpeedKt: num(ac.gs),
    trueAirSpeedKt: num(ac.tas),
    indicatedAirSpeedKt: num(ac.ias),
    mach: num(ac.mach),
    trackDeg: num(ac.track) !== null ? num(ac.track) : num(ac.true_heading),
    headingDeg: num(ac.true_heading) !== null ? num(ac.true_heading) : num(ac.mag_heading),
    verticalRateFpm: num(ac.baro_rate) !== null ? num(ac.baro_rate) : num(ac.geom_rate),
    selectedAltitudeFt: num(ac.nav_altitude_mcp),
    squawk: ac.squawk || null,
    outsideAirTempC: num(ac.oat),
    windDirDeg: num(ac.wd),
    windSpeedKt: num(ac.ws),
    onGround,
    positionAgeSec: num(ac.seen_pos) !== null ? num(ac.seen_pos) : num(ac.seen),
    observedAt: Date.now()
  };
}

function pickReadsbAircraft(json, sourceLabel) {
  const list = (json && (json.ac || json.aircraft)) || [];
  if (!Array.isArray(list) || list.length === 0) return null;
  const candidates = list.filter((ac) => callsignMatches(ac.flight));
  const chosen = (candidates.length ? candidates : list)
    .map((ac) => mapReadsbAircraft(ac, sourceLabel))
    .filter(Boolean)
    // juengste Position gewinnt
    .sort((a, b) => (a.positionAgeSec || 0) - (b.positionAgeSec || 0))[0];
  return chosen || null;
}

const M_TO_FT = 3.280839895;
const MS_TO_KT = 1.9438444924;

function pickOpenSkyAircraft(json, sourceLabel) {
  const states = (json && json.states) || [];
  if (!Array.isArray(states)) return null;
  const s = states.find((st) => callsignMatches(st[1]));
  if (!s) return null;
  const lat = num(s[6]);
  const lon = num(s[5]);
  if (lat === null || lon === null) return null;
  const altM = num(s[7]) !== null ? num(s[7]) : num(s[13]);
  const lastContact = num(s[4]);
  return {
    source: sourceLabel,
    icao24: s[0] || null,
    callsign: String(s[1] || '').trim() || CONFIG.callsign,
    registration: null,
    aircraftType: null,
    lat,
    lon,
    altitudeFt: altM !== null ? Math.round(altM * M_TO_FT) : null,
    geoAltitudeFt: num(s[13]) !== null ? Math.round(num(s[13]) * M_TO_FT) : null,
    groundSpeedKt: num(s[9]) !== null ? Math.round(num(s[9]) * MS_TO_KT) : null,
    trueAirSpeedKt: null,
    indicatedAirSpeedKt: null,
    mach: null,
    trackDeg: num(s[10]),
    headingDeg: num(s[10]),
    verticalRateFpm: num(s[11]) !== null ? Math.round(num(s[11]) * M_TO_FT * 60) : null,
    selectedAltitudeFt: null,
    squawk: s[14] || null,
    outsideAirTempC: null,
    windDirDeg: null,
    windSpeedKt: null,
    onGround: Boolean(s[8]),
    positionAgeSec: lastContact ? Math.max(0, Math.round(Date.now() / 1000 - lastContact)) : null,
    observedAt: Date.now()
  };
}

/* Bounding-Box grob ueber den Korridor Muenchen - Dubai, damit die
 * OpenSky-Antwort klein bleibt. */
const OPENSKY_BBOX = 'lamin=20&lomin=4&lamax=53&lomax=60';

const SOURCES = [
  {
    label: 'adsb.lol',
    url: () => 'https://api.adsb.lol/v2/callsign/' + encodeURIComponent(CONFIG.callsign),
    parse: (json) => pickReadsbAircraft(json, 'adsb.lol')
  },
  {
    label: 'adsb.fi',
    url: () => 'https://opendata.adsb.fi/api/v2/callsign/' + encodeURIComponent(CONFIG.callsign),
    parse: (json) => pickReadsbAircraft(json, 'adsb.fi')
  },
  {
    label: 'airplanes.live',
    url: () => 'https://api.airplanes.live/v2/callsign/' + encodeURIComponent(CONFIG.callsign),
    parse: (json) => pickReadsbAircraft(json, 'airplanes.live')
  },
  {
    label: 'opensky',
    url: () => 'https://opensky-network.org/api/states/all?' + OPENSKY_BBOX,
    parse: (json) => pickOpenSkyAircraft(json, 'opensky')
  }
];

/**
 * Fragt alle Quellen der Reihe nach ab.
 * @returns {Promise<{ok: boolean, aircraft: object|null, attempts: Array, checkedAt: number}>}
 */
async function fetchFlightState() {
  const attempts = [];
  for (const source of SOURCES) {
    try {
      const json = await httpGetJson(source.url(), CONFIG.requestTimeoutMs);
      const aircraft = source.parse(json);
      if (aircraft) {
        attempts.push({ source: source.label, status: 'hit' });
        return { ok: true, aircraft, attempts, checkedAt: Date.now() };
      }
      attempts.push({ source: source.label, status: 'kein-treffer' });
    } catch (err) {
      attempts.push({ source: source.label, status: 'fehler', message: err.message });
    }
  }
  return { ok: false, aircraft: null, attempts, checkedAt: Date.now() };
}

module.exports = { fetchFlightState, callsignMatches, pickReadsbAircraft, pickOpenSkyAircraft };
