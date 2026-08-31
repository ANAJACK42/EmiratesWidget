/*
 * Erzeugt renderer/cities.js: eine kuratierte Liste grosser Staedte entlang
 * der Route und drumherum. Die Koordinaten stammen aus dem npm-Paket
 * cities.json (GeoNames, CC-BY), nicht aus geschaetzten Werten.
 *
 * rank 1 = immer sichtbar, 2 = ab Zoomstufe 5, 3 = ab Zoomstufe 6
 */
const fs = require('fs');
const path = require('path');
const all = require('cities.json');

const WANTED = [
  // Europa
  ['Munich', 'DE', 1], ['Berlin', 'DE', 2], ['Frankfurt am Main', 'DE', 3], ['Hamburg', 'DE', 3],
  ['Vienna', 'AT', 1], ['Zürich', 'CH', 2], ['Milan', 'IT', 2], ['Rome', 'IT', 1], ['Venice', 'IT', 3],
  ['Naples', 'IT', 3], ['Prague', 'CZ', 2], ['Warsaw', 'PL', 2], ['Budapest', 'HU', 1],
  ['Zagreb', 'HR', 3], ['Belgrade', 'RS', 2], ['Sarajevo', 'BA', 3], ['Sofia', 'BG', 2],
  ['Bucharest', 'RO', 2], ['Skopje', 'MK', 3], ['Tirana', 'AL', 3], ['Thessaloníki', 'GR', 3],
  ['Athens', 'GR', 1], ['Paris', 'FR', 1], ['London', 'GB', 1], ['Madrid', 'ES', 1],
  ['Barcelona', 'ES', 3], ['Amsterdam', 'NL', 2], ['Brussels', 'BE', 3], ['Copenhagen', 'DK', 3],
  ['Stockholm', 'SE', 3], ['Oslo', 'NO', 3], ['Kyiv', 'UA', 2], ['Odesa', 'UA', 3],
  ['Minsk', 'BY', 3], ['Moscow', 'RU', 1], ['Lisbon', 'PT', 3],
  // Türkei, Kaukasus
  ['Istanbul', 'TR', 1], ['Ankara', 'TR', 2], ['İzmir', 'TR', 3], ['Antalya', 'TR', 3],
  ['Adana', 'TR', 3], ['Trabzon', 'TR', 3], ['Baku', 'AZ', 2], ['Tbilisi', 'GE', 3], ['Yerevan', 'AM', 3],
  // Naher Osten
  ['Nicosia', 'CY', 3], ['Beirut', 'LB', 2], ['Damascus', 'SY', 2], ['Aleppo', 'SY', 3],
  ['Amman', 'JO', 2], ['Jerusalem', 'IL', 2], ['Tel Aviv', 'IL', 3],
  ['Baghdad', 'IQ', 1], ['Mosul', 'IQ', 3], ['Basrah', 'IQ', 3], ['Erbil', 'IQ', 3],
  ['Kuwait City', 'KW', 2], ['Tehran', 'IR', 1], ['Tabriz', 'IR', 3], ['Isfahan', 'IR', 2],
  ['Shiraz', 'IR', 3], ['Bandar Abbas', 'IR', 3], ['Mashhad', 'IR', 3],
  ['Riyadh', 'SA', 1], ['Jeddah', 'SA', 2], ['Makkah', 'SA', 3], ['Madinah', 'SA', 3],
  ['Dammam', 'SA', 3], ['Doha', 'QA', 2], ['Manama', 'BH', 3],
  ['Abu Dhabi', 'AE', 1], ['Dubai', 'AE', 1], ['Sharjah', 'AE', 3], ['Al Ain City', 'AE', 3],
  ['Muscat', 'OM', 2], ['Sanaa', 'YE', 3],
  // Afrika
  ['Cairo', 'EG', 1], ['Alexandria', 'EG', 3], ['Luxor', 'EG', 3], ['Khartoum', 'SD', 3],
  ['Tripoli', 'LY', 3], ['Benghazi', 'LY', 3], ['Tunis', 'TN', 3], ['Algiers', 'DZ', 3],
  ['Addis Ababa', 'ET', 3], ['Djibouti', 'DJ', 3],
  // Süd- und Zentralasien
  ['Karachi', 'PK', 2], ['Lahore', 'PK', 3], ['Islamabad', 'PK', 3], ['Kabul', 'AF', 2],
  ['Delhi', 'IN', 2], ['Mumbai', 'IN', 2], ['Ashgabat', 'TM', 3], ['Tashkent', 'UZ', 3]
];

/* Anzeigenamen: kurz und im Cockpit-Stil lesbar */
const DISPLAY = {
  'Munich': 'MUENCHEN', 'Vienna': 'WIEN', 'Zürich': 'ZUERICH', 'Rome': 'ROM', 'Milan': 'MAILAND',
  'Prague': 'PRAG', 'Warsaw': 'WARSCHAU', 'Belgrade': 'BELGRAD', 'Bucharest': 'BUKAREST',
  'Athens': 'ATHEN', 'Thessaloníki': 'THESSALONIKI', 'İzmir': 'IZMIR', 'Istanbul': 'ISTANBUL',
  'Nicosia': 'NIKOSIA', 'Damascus': 'DAMASKUS', 'Jerusalem': 'JERUSALEM', 'Baghdad': 'BAGDAD',
  'Basrah': 'BASRA', 'Kuwait City': 'KUWAIT', 'Tehran': 'TEHERAN', 'Isfahan': 'ISFAHAN',
  'Makkah': 'MEKKA', 'Madinah': 'MEDINA', 'Al Ain City': 'AL AIN',
  'Cairo': 'KAIRO', 'Alexandria': 'ALEXANDRIA', 'Algiers': 'ALGIER', 'Moscow': 'MOSKAU',
  'Copenhagen': 'KOPENHAGEN', 'Lisbon': 'LISSABON', 'Brussels': 'BRUESSEL', 'Venice': 'VENEDIG',
  'Naples': 'NEAPEL', 'Delhi': 'DELHI', 'Mumbai': 'MUMBAI', 'Khartoum': 'KHARTUM'
};

const index = new Map();
for (const city of all) {
  const key = city.name + '|' + city.country;
  // Erster Treffer je Name/Land genügt; GeoNames führt den Hauptort zuerst
  if (!index.has(key)) index.set(key, city);
}

const result = [];
const missing = [];
for (const [name, country, rank] of WANTED) {
  const hit = index.get(name + '|' + country);
  if (!hit) { missing.push(name + ' (' + country + ')'); continue; }
  const label = DISPLAY[name] || name;
  result.push([label, Math.round(Number(hit.lat) * 1000) / 1000, Math.round(Number(hit.lng) * 1000) / 1000, rank]);
}

const out =
  '/* Automatisch erzeugt von tools/build-cities.js – nicht von Hand ändern.\n' +
  '   Städtekoordinaten: GeoNames über das npm-Paket cities.json (CC-BY).\n' +
  '   Format: [Name, Breite, Länge, Rang]; Rang 1 immer, 2 ab Zoom 5, 3 ab Zoom 6. */\n' +
  '(function (root, factory) {\n' +
  "  if (typeof module === 'object' && module.exports) module.exports = factory();\n" +
  '  else root.EK_CITIES = factory();\n' +
  "})(typeof self !== 'undefined' ? self : this, function () {\n" +
  '  return ' + JSON.stringify(result) + ';\n' +
  '});\n';

fs.writeFileSync(path.join(__dirname, '..', 'renderer/cities.js'), out, 'utf8');
console.log('renderer/cities.js:', result.length, 'Städte,', Math.round(out.length / 1024), 'KB');
if (missing.length) console.log('nicht gefunden:', missing.join(', '));
