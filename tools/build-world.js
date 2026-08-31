/*
 * Erzeugt renderer/world.js: Küstenlinien und Ländergrenzen als GeoJSON,
 * eingebettet in eine Datei. Quelle: Natural Earth (Public Domain) über das
 * npm-Paket world-atlas, umgewandelt mit topojson-client.
 *
 * Dadurch braucht die Karte keine Kachel-Server, keinen API-Schlüssel und
 * keine Internetverbindung.
 */
const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');
const simplifyTools = require('topojson-simplify');

const root = path.join(__dirname, '..');
const atlas = (name) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules/world-atlas', name), 'utf8'));

/** Koordinaten runden (~1 km) und dabei doppelte Nachbarpunkte entfernen. */
function roundRing(ring) {
  const out = [];
  for (const point of ring) {
    const p = [Math.round(point[0] * 100) / 100, Math.round(point[1] * 100) / 100];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/** Rundet rekursiv bis auf die Ring-Ebene (Punktlisten). */
function roundCoords(value) {
  if (typeof value[0][0] === 'number') return roundRing(value);
  return value.map(roundCoords);
}

/** Ringe/Linien mit zu wenigen Stützpunkten (Kleinstinseln) entfernen. */
function prune(geometry, minPoints) {
  if (geometry.type === 'MultiPolygon') {
    geometry.coordinates = geometry.coordinates.filter((poly) => poly[0].length >= minPoints);
  } else if (geometry.type === 'MultiLineString') {
    geometry.coordinates = geometry.coordinates.filter((line) => line.length >= minPoints);
  }
  return geometry;
}

/** Natural Earth 1:50m ist sehr fein; leicht vereinfacht bleibt die Küstenlinie
 *  bis Zoomstufe 8 sauber, die Datei aber klein genug zum Einbetten. */
function simplified(topo, weight) {
  return simplifyTools.simplify(simplifyTools.presimplify(topo), weight);
}

const landTopo = simplified(atlas('land-50m.json'), 0.05);
const landFc = topojson.feature(landTopo, landTopo.objects.land);
const land = landFc.features[0].geometry;
land.coordinates = roundCoords(land.coordinates);
prune(land, 6); // Kleinstinseln nach dem Runden verwerfen

const countriesTopo = simplified(atlas('countries-50m.json'), 0.1);
// mesh(..., a !== b) liefert nur die Grenzen zwischen Ländern, ohne Küstenlinien doppelt
const borders = topojson.mesh(countriesTopo, countriesTopo.objects.countries, (a, b) => a !== b);
borders.coordinates = roundCoords(borders.coordinates);
prune(borders, 4);

const out =
  '/* Automatisch erzeugt von tools/build-world.js – nicht von Hand ändern.\n' +
  '   Kartendaten: Natural Earth (Public Domain) via npm-Paket world-atlas. */\n' +
  '(function (root, factory) {\n' +
  "  if (typeof module === 'object' && module.exports) module.exports = factory();\n" +
  '  else root.EK_WORLD = factory();\n' +
  "})(typeof self !== 'undefined' ? self : this, function () {\n" +
  '  return {\n' +
  '    land: ' + JSON.stringify(land) + ',\n' +
  '    borders: ' + JSON.stringify(borders) + '\n' +
  '  };\n' +
  '});\n';

const target = path.join(root, 'renderer/world.js');
fs.writeFileSync(target, out, 'utf8');
console.log('renderer/world.js:', Math.round(out.length / 1024), 'KB',
  '| Landflächen:', land.coordinates.length, '| Grenzlinien:', borders.coordinates.length);
