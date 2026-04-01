/**
 * NDVI Color Ramp
 *
 * Maps an NDVI float value in [-1, 1] to an RGBA Uint8 color.
 * Uses a perceptually tuned diverging ramp:
 *   -1.0  →  deep blue   (water / shadow)
 *   -0.2  →  brown       (bare soil)
 *    0.0  →  tan
 *    0.2  →  light green  (sparse vegetation)
 *    0.5  →  green        (moderate vegetation)
 *    0.8+ →  dark green   (dense vegetation)
 */

const STOPS = [
  { val: -1.0, r: 44, g: 64, b: 114 },   // deep blue
  { val: -0.2, r: 140, g: 100, b: 60 },   // brown
  { val: 0.0, r: 210, g: 190, b: 140 },   // tan
  { val: 0.1, r: 220, g: 210, b: 120 },   // pale yellow
  { val: 0.2, r: 180, g: 210, b: 80 },    // yellow-green
  { val: 0.4, r: 100, g: 180, b: 50 },    // light green
  { val: 0.6, r: 40, g: 140, b: 30 },     // green
  { val: 0.8, r: 10, g: 100, b: 20 },     // dark green
  { val: 1.0, r: 0, g: 60, b: 10 },       // very dark green
];

/**
 * Linearly interpolate between two color stops.
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Convert an NDVI value to [r, g, b, a] (0-255).
 * @param {number} ndvi  Value in [-1, 1]
 * @returns {[number, number, number, number]}
 */
export function ndviToRGBA(ndvi) {
  // Clamp
  const v = Math.max(-1, Math.min(1, ndvi));

  // Find the two surrounding stops
  for (let i = 0; i < STOPS.length - 1; i++) {
    const lo = STOPS[i];
    const hi = STOPS[i + 1];
    if (v >= lo.val && v <= hi.val) {
      const t = (v - lo.val) / (hi.val - lo.val);
      return [
        Math.round(lerp(lo.r, hi.r, t)),
        Math.round(lerp(lo.g, hi.g, t)),
        Math.round(lerp(lo.b, hi.b, t)),
        255,
      ];
    }
  }

  // Fallback (shouldn't reach)
  const last = STOPS[STOPS.length - 1];
  return [last.r, last.g, last.b, 255];
}
