/*
 * Holt die aktuelle Position von EK050 (Rufzeichen UAE5T) und schreibt sie
 * nach data/flight.json.
 *
 * Läuft in GitHub Actions, also serverseitig: keine CORS-Grenzen, keine
 * Abhängigkeit davon, was der Browser des Betrachters erreichen darf.
 * Die erzeugte Datei wird von GitHub Pages ausgeliefert, das Widget liest
 * sie von derselben Adresse.
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('../config');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'flight.json');
const TRACK = path.join(ROOT, 'data', 'track.json');

// Sparsam bleiben: die Dienste drosseln hart. Nur die zwei plausibelsten Kennungen.
const CALLSIGNS = [CONFIG.callsign, 'UAE50'];
// airplanes.live verlangt inzwischen einen Schlüssel (403) und bleibt draußen.
const ENDPOINTS = [
  (cs) => ({ name: 'adsb.lol', url: 'https://api.adsb.lol/v2/callsign/' + cs }),
  (cs) => ({ name: 'adsb.fi', url: 'https://opendata.adsb.fi/api/v2/callsign/' + cs })
];

// Beide Dienste drosseln bei zu schnellen Anfragen (HTTP 429)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function normalize(ac, source) {
  const onGround = ac.alt_baro === 'ground';
  return {
    source,
    icao24: ac.hex || null,
    callsign: String(ac.flight || '').trim(),
    registration: ac.r || null,
    aircraftType: ac.t || null,
    lat: num(ac.lat),
    lon: num(ac.lon),
    altitudeFt: onGround ? 0 : num(ac.alt_baro),
    geoAltitudeFt: num(ac.alt_geom),
    groundSpeedKt: num(ac.gs),
    trueAirSpeedKt: num(ac.tas),
    indicatedAirSpeedKt: num(ac.ias),
    mach: num(ac.mach),
    trackDeg: num(ac.track) !== null ? num(ac.track) : num(ac.true_heading),
    headingDeg: num(ac.true_heading),
    verticalRateFpm: num(ac.baro_rate) !== null ? num(ac.baro_rate) : num(ac.geom_rate),
    squawk: ac.squawk || null,
    windDirDeg: num(ac.wd),
    windSpeedKt: num(ac.ws),
    outsideAirTempC: num(ac.oat),
    onGround,
    positionAgeSec: num(ac.seen_pos) !== null ? num(ac.seen_pos) : num(ac.seen),
    observedAt: Date.now()
  };
}

async function get(url, retries = 2) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EK050-Widget/1.0 (personal flight tracking)', Accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
    if (res.ok) return res.json();
    // Drosselung: warten und erneut versuchen
    if (res.status === 429 && attempt < retries) {
      await pause(4000 * (attempt + 1));
      continue;
    }
    throw new Error('HTTP ' + res.status);
  }
}

/* OpenSky liefert mit einer einzigen Anfrage alle Flugzeuge im Rechteck
   zwischen Mitteleuropa und dem Golf – ideal, um zu sehen, was überhaupt
   unterwegs ist, ohne die anderen Dienste zu drosseln. */
const OPENSKY_BBOX = 'https://opensky-network.org/api/states/all?lamin=18&lomin=2&lamax=54&lomax=62';

function fromOpenSky(state) {
  const M_TO_FT = 3.280839895;
  const MS_TO_KT = 1.9438444924;
  const altM = num(state[7]) !== null ? num(state[7]) : num(state[13]);
  return {
    source: 'opensky',
    icao24: state[0] || null,
    callsign: String(state[1] || '').trim(),
    registration: null,
    aircraftType: null,
    lat: num(state[6]),
    lon: num(state[5]),
    altitudeFt: altM !== null ? Math.round(altM * M_TO_FT) : null,
    geoAltitudeFt: num(state[13]) !== null ? Math.round(num(state[13]) * M_TO_FT) : null,
    groundSpeedKt: num(state[9]) !== null ? Math.round(num(state[9]) * MS_TO_KT) : null,
    trueAirSpeedKt: null,
    indicatedAirSpeedKt: null,
    mach: null,
    trackDeg: num(state[10]),
    headingDeg: num(state[10]),
    verticalRateFpm: num(state[11]) !== null ? Math.round(num(state[11]) * M_TO_FT * 60) : null,
    squawk: state[14] || null,
    windDirDeg: null,
    windSpeedKt: null,
    outsideAirTempC: null,
    onGround: Boolean(state[8]),
    positionAgeSec: num(state[4]) !== null ? Math.max(0, Math.round(Date.now() / 1000 - num(state[4]))) : null,
    observedAt: Date.now()
  };
}

(async () => {
  const attempts = [];
  let aircraft = null;

  /* Zuerst über das Kennzeichen suchen: eindeutig und unabhängig davon, welches
     Rufzeichen die Besatzung gesetzt hat. */
  if (CONFIG.registration) {
    for (const [name, url] of [
      ['adsb.lol reg', 'https://api.adsb.lol/v2/reg/' + CONFIG.registration],
      ['adsb.fi reg', 'https://opendata.adsb.fi/api/v2/reg/' + CONFIG.registration]
    ]) {
      const label = name + ' ' + CONFIG.registration;
      try {
        const json = await get(url);
        const list = (json && (json.ac || json.aircraft)) || [];
        const hit = list.find((a) => Number.isFinite(Number(a.lat)));
        if (hit) {
          aircraft = normalize(hit, name);
          attempts.push({ label, status: 'OK' });
          break;
        }
        attempts.push({ label, status: 'antwortet, kein Treffer (' + list.length + ' Einträge)' });
      } catch (err) {
        attempts.push({ label, status: String(err.message || err) });
      }
      await pause(2500);
    }
  }

  outer: for (const callsign of (aircraft ? [] : CALLSIGNS)) {
    for (const make of ENDPOINTS) {
      const { name, url } = make(callsign);
      const label = name + ' ' + callsign;
      try {
        const json = await get(url);
        const list = (json && (json.ac || json.aircraft)) || [];
        const hit = list.find((a) => Number.isFinite(Number(a.lat)));
        if (hit) {
          aircraft = normalize(hit, name);
          attempts.push({ label, status: 'OK' });
          break outer;
        }
        attempts.push({ label, status: 'antwortet, kein Treffer (' + list.length + ' Einträge)' });
      } catch (err) {
        attempts.push({ label, status: String(err.message || err) });
      }
      await pause(2500);
    }
  }

  /* Kein Treffer? Dann nachsehen, welche Emirates-Maschinen die Feeds entlang
     der Strecke überhaupt sehen. Das trennt "Feed kaputt" von "nicht in der Luft". */
  let nearby = [];
  if (!aircraft) {
    try {
      const json = await get(OPENSKY_BBOX, 1);
      const states = (json && json.states) || [];
      const emirates = states
        .filter((st) => String(st[1] || '').trim().toUpperCase().startsWith('UAE'))
        .map(fromOpenSky)
        .filter((a) => a.lat !== null);
      attempts.push({ label: 'opensky Korridor', status: states.length + ' Flugzeuge im Rechteck, davon ' + emirates.length + ' Emirates' });
      nearby = emirates;

      // Ist unsere Maschine darunter? Dann ist sie gefunden.
      const target = emirates.find((a) => CONFIG.callsignVariants
        .map((v) => v.toUpperCase()).includes(a.callsign.toUpperCase()));
      if (target) { aircraft = target; attempts.push({ label: 'opensky ' + target.callsign, status: 'OK' }); }
    } catch (err) {
      attempts.push({ label: 'opensky Korridor', status: String(err.message || err) });
    }
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    nearbyEmirates: nearby,
    flight: CONFIG.flightIata,
    callsign: CONFIG.callsign,
    ok: Boolean(aircraft),
    aircraft,
    attempts
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');

  // Spur mitschreiben, damit die tatsächlich geflogene Route erhalten bleibt
  if (aircraft) {
    let track = [];
    try { track = JSON.parse(fs.readFileSync(TRACK, 'utf8')); } catch (err) { track = []; }
    if (!Array.isArray(track)) track = [];
    const point = {
      t: payload.updatedAt,
      lat: Math.round(aircraft.lat * 10000) / 10000,
      lon: Math.round(aircraft.lon * 10000) / 10000,
      alt: aircraft.altitudeFt,
      gs: aircraft.groundSpeedKt
    };
    const last = track[track.length - 1];
    if (!last || last.lat !== point.lat || last.lon !== point.lon) track.push(point);
    fs.writeFileSync(TRACK, JSON.stringify(track.slice(-2000)) + '\n');
  }

  console.log(JSON.stringify(payload, null, 2));
  if (!aircraft) process.exitCode = 0; // kein Fehler: die Maschine kann am Boden stehen
})();
