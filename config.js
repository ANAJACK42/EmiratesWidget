/*
 * Gemeinsame Konfiguration fuer Main- und Renderer-Prozess.
 * Wird per require() (Node) oder per <script> (Browser -> window.EK_CONFIG) geladen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EK_CONFIG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    // Flugnummer (IATA) und Funkrufzeichen (ICAO) - EK = Emirates = UAE
    flightIata: 'EK050',
    callsign: 'UAE50',
    // Alternative Schreibweisen, die die ADS-B-Feeder liefern koennen
    callsignVariants: ['UAE50', 'UAE050', 'UAE0050', 'EK50', 'EK050'],

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

    // Aktualisierungsintervall in Millisekunden (5 Minuten)
    refreshIntervalMs: 5 * 60 * 1000,
    // Timeout pro Datenquelle
    requestTimeoutMs: 12000,
    // Maximale Anzahl gespeicherter Trackpunkte
    maxTrackPoints: 600
  };
});
