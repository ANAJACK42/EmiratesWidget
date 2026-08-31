/*
 * Baut EK050-Widget.html: eine einzige Datei mit Stylesheet, Konfiguration
 * und Skripten inline. Nur Leaflet bleibt am CDN.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');
// Der Web-Einstieg traegt Versionsstempel (?v=N) gegen den Browser-Cache;
// fuer die Einzeldatei werden sie vor dem Einbetten entfernt.
html = html.replace(/(src|href)="([^"]+)\?v=\d+"/g, '$1="$2"');

// Leaflet für die Einzeldatei mit einbetten: dann läuft sie komplett ohne Netz
// (bis auf die Flugdaten) und ohne Abhängigkeit von einem CDN.
html = html.replace(/\s*<link rel="stylesheet" href="https:\/\/unpkg\.com\/leaflet[^>]*>/,
  '\n    <style>\n' + read('node_modules/leaflet/dist/leaflet.css') + '\n</style>');
html = html.replace(/\s*<script src="https:\/\/unpkg\.com\/leaflet[^<]*<\/script>/,
  '\n    <script>\n' + read('node_modules/leaflet/dist/leaflet.js') + '\n</script>');
if (html.includes('unpkg.com')) throw new Error('Leaflet wurde nicht eingebettet');

const inlines = [
  ['<link rel="stylesheet" href="renderer/styles.css" />', '<style>\n' + read('renderer/styles.css') + '\n</style>'],
  ['<script src="config.js"></script>', '<script>\n' + read('config.js') + '\n</script>'],
  ['<script src="renderer/geo.js"></script>', '<script>\n' + read('renderer/geo.js') + '\n</script>'],
  ['<script src="renderer/world.js"></script>', '<script>\n' + read('renderer/world.js') + '\n</script>'],
  ['<script src="renderer/cities.js"></script>', '<script>\n' + read('renderer/cities.js') + '\n</script>'],
  ['<script src="renderer/app.js"></script>', '<script>\n' + read('renderer/app.js') + '\n</script>']
];
for (const [needle, replacement] of inlines) {
  if (!html.includes(needle)) throw new Error('Platzhalter nicht gefunden: ' + needle);
  html = html.replace(needle, replacement);
}
if (/(src|href)="renderer\//.test(html)) throw new Error('Es sind noch lokale Verweise uebrig');

fs.writeFileSync(path.join(root, 'EK050-Widget.html'), html, 'utf8');
console.log('EK050-Widget.html geschrieben (' + Math.round(html.length / 1024) + ' KB)');
