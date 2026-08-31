/* Grosskreis-Mathematik fuer Route, Distanzen und Peilungen. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GEO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const R_NM = 3440.065; // Erdradius in nautischen Meilen
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  function distanceNm(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingDeg(a, b) {
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /* Punkt auf dem Grosskreis zwischen a und b, fraction 0..1 */
  function interpolate(a, b, fraction) {
    const lat1 = toRad(a.lat);
    const lon1 = toRad(a.lon);
    const lat2 = toRad(b.lat);
    const lon2 = toRad(b.lon);
    const d = distanceNm(a, b) / R_NM;
    if (d === 0) return { lat: a.lat, lon: a.lon };
    const A = Math.sin((1 - fraction) * d) / Math.sin(d);
    const B = Math.sin(fraction * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    return {
      lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
      lon: toDeg(Math.atan2(y, x))
    };
  }

  function greatCircle(a, b, segments) {
    const n = Math.max(2, segments || 96);
    const points = [];
    for (let i = 0; i <= n; i += 1) points.push(interpolate(a, b, i / n));
    return points;
  }

  /* Zielpunkt aus Startpunkt, Peilung und Distanz (Koppelnavigation) */
  function destination(a, bearing, distNm) {
    const d = distNm / R_NM;
    const brg = toRad(bearing);
    const lat1 = toRad(a.lat);
    const lon1 = toRad(a.lon);
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
    const lon2 =
      lon1 +
      Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
  }

  /* Wie weit ist die Strecke abgeflogen (0..1), projiziert auf die Direkt-Route */
  function progressFraction(origin, dest, current) {
    const total = distanceNm(origin, dest);
    if (total <= 0) return 0;
    const flown = distanceNm(origin, current);
    const remaining = distanceNm(current, dest);
    // Normieren, damit Umwege die Anzeige nicht ueber 100 % treiben
    const sum = flown + remaining;
    const ratio = sum > 0 ? flown / sum : 0;
    return Math.min(1, Math.max(0, ratio));
  }

  function formatLat(lat) {
    const hemi = lat >= 0 ? 'N' : 'S';
    const abs = Math.abs(lat);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return hemi + String(deg).padStart(2, '0') + '°' + min.toFixed(1).padStart(4, '0') + "'";
  }

  function formatLon(lon) {
    const hemi = lon >= 0 ? 'E' : 'W';
    const abs = Math.abs(lon);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return hemi + String(deg).padStart(3, '0') + '°' + min.toFixed(1).padStart(4, '0') + "'";
  }

  return {
    R_NM,
    distanceNm,
    bearingDeg,
    interpolate,
    greatCircle,
    destination,
    progressFraction,
    formatLat,
    formatLon
  };
});
