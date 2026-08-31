/*
 * Gemeinsame Konfiguration fuer Main- und Renderer-Prozess.
 * Wird per require() (Node) oder per <script> (Browser -> window.EK_CONFIG) geladen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EK_CONFIG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    // Bauversion – steht im DIAG-Fenster, damit erkennbar ist, welcher Stand läuft
    version: '2026-08-31.10',

    /*
     * Flugnummer (IATA) und Funkrufzeichen (ICAO).
     *
     * Achtung: Emirates fliegt EK050 nicht unter "UAE50", sondern unter dem
     * alphanumerischen Rufzeichen "UAE5T" - solche Kennungen vergeben viele
     * Airlines, um Verwechslungen im Funk zu vermeiden. Genau danach muss in
     * den ADS-B-Feeds gesucht werden; "UAE50" findet nichts.
     */
    flightIata: 'EK050',
    callsign: 'UAE5T',
    /*
     * Kennzeichen des Flugzeugs (Emirates A380-861, A6-EEP).
     * Die Registrierung ist die zuverlässigste Kennung: Sie ändert sich nicht,
     * während das Rufzeichen je nach Flug wechselt und in den Feeds fehlen kann.
     */
    registration: 'A6-EEP',
    // Weitere Schreibweisen, die Feeder liefern oder die an anderen Tagen gelten koennen
    callsignVariants: ['UAE5T', 'UAE50', 'UAE050', 'UAE0050', 'EK50', 'EK050'],

    origin: {
      iata: 'MUC',
      icao: 'EDDM',
      name: 'Muenchen Franz Josef Strauss',
      lat: 48.3538,
      lon: 11.7861,
      tz: 'Europe/Berlin',
      elevationFt: 1487
    },
    destination: {
      iata: 'DXB',
      icao: 'OMDB',
      name: 'Dubai International',
      lat: 25.2532,
      lon: 55.3657,
      tz: 'Asia/Dubai',
      elevationFt: 62
    },

    /*
     * Geplante Route als Stützpunkte [Breite, Länge, Name].
     *
     * WICHTIG: Das ist NICHT der amtliche Flugplan, sondern der südliche
     * Korridor, den Emirates zwischen Europa und Dubai fliegt, seit der
     * Luftraum über Irak, Iran und Syrien gemieden wird: über die Adria und
     * Griechenland ins Mittelmeer, über Ägypten den Nil hinunter, über das
     * Rote Meer nach Saudi-Arabien und von dort an den Golf.
     *
     * Die Linie dient nur als Erwartung. Sobald echte Positionen eintreffen,
     * zeichnet das Widget die tatsächlich geflogene Spur und merkt sie sich;
     * ab dem zweiten Flug wird die gelernte Spur als Route verwendet.
     */
    plannedRoute: [
      [48.35, 11.79, 'MUC'],
      [47.80, 13.04, 'SALZBURG'],
      [46.22, 14.48, 'LJUBLJANA'],
      [44.50, 15.60, 'ADRIA N'],
      [42.60, 17.60, 'ADRIA S'],
      [40.60, 19.30, 'OTRANTO'],
      [38.60, 21.40, 'IONISCHES MEER'],
      [36.40, 23.60, 'PELOPONNES'],
      [34.60, 26.20, 'KRETA OST'],
      [32.60, 28.40, 'MITTELMEER SO'],
      [31.20, 29.95, 'ALEXANDRIA'],
      [30.05, 31.25, 'KAIRO'],
      [27.20, 31.20, 'ASYUT'],
      [25.70, 32.65, 'LUXOR'],
      [24.60, 34.60, 'ROTES MEER'],
      [22.60, 37.20, 'ROTES MEER S'],
      [22.40, 39.60, 'JEDDAH'],
      [23.60, 43.00, 'ZENTRAL-SAUDI'],
      [24.70, 46.70, 'RIYADH'],
      [25.30, 50.10, 'GOLF W'],
      [25.25, 55.37, 'DXB']
    ],

    // Aktualisierungsintervall in Millisekunden (5 Minuten)
    refreshIntervalMs: 5 * 60 * 1000,
    // Timeout pro Datenquelle
    requestTimeoutMs: 12000,
    // Maximale Anzahl gespeicherter Trackpunkte
    maxTrackPoints: 600
  };
});
