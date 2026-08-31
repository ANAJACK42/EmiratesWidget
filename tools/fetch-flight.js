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

const CALLSIGNS = CONFIG.callsignVariants;
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

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'EK050-Widget/1.0 (personal flight tracking)', Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

(async () => {
  const attempts = [];
  let aircraft = null;

  outer: for (const callsign of CALLSIGNS) {
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
      await pause(1200);
    }
  }

  /* Kein Treffer? Dann nachsehen, welche Emirates-Maschinen die Feeds entlang
     der Strecke überhaupt sehen. Das trennt "Feed kaputt" von "nicht in der Luft". */
  let nearby = [];
  if (!aircraft) {
    const probes = [
      [48.0, 12.0, 'Muenchen'], [44.5, 16.0, 'Adria'], [37.0, 24.0, 'Griechenland'],
      [30.5, 31.0, 'Aegypten'], [24.5, 38.0, 'Rotes Meer'], [24.7, 46.7, 'Saudi'],
      [25.2, 55.3, 'Dubai']
    ];
    const seen = new Map();
    for (const [lat, lon, name] of probes) {
      try {
        const json = await get('https://api.adsb.lol/v2/point/' + lat + '/' + lon + '/250');
        const list = (json && json.ac) || [];
        let uae = 0;
        for (const a of list) {
          const cs = String(a.flight || '').trim().toUpperCase();
          if (!cs.startsWith('UAE')) continue;
          uae += 1;
          seen.set(cs, {
            callsign: cs, registration: a.r || null, type: a.t || null,
            lat: num(a.lat), lon: num(a.lon), altitudeFt: a.alt_baro, groundSpeedKt: num(a.gs),
            trackDeg: num(a.track), area: name
          });
        }
        attempts.push({ label: 'Umkreis ' + name, status: list.length + ' Flugzeuge, davon ' + uae + ' Emirates' });
      } catch (err) {
        attempts.push({ label: 'Umkreis ' + name, status: String(err.message || err) });
      }
      await pause(1200);
    }
    nearby = [...seen.values()];
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
