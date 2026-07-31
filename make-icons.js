// Write public/icon.svg and the home screen PNGs from one set of numbers.
//
// Run: node make-icons.js
//
// An ensō: a circle drawn in one breath and left open where the brush lifted.
// The same mark the app shows while it is loading, which is the whole reason
// it is the icon — the first thing you see is the thing you are waiting on.
//
// THE SVG IS GENERATED, not maintained alongside this file. The old pair were
// twins that had to be kept in step by hand, and they were not: the SVG read
// a shape's ends as the outer edge of its rect while this file read them as
// the segment, so the PNG was 18px wider at each end than the drawing it
// claimed to be, and nothing caught it. Two files cannot disagree if only one
// of them is written.
//
// There is no rasteriser here and adding one would be a build dependency for
// three files that change once a year, so the drawing is computed directly and
// encoded with the zlib that ships with Node.

const fs = require('fs');
const zlib = require('zlib');

// --- the ink -----------------------------------------------------------------

const PAPER = [0xf5, 0xf1, 0xe8]; // --bg
const FIBRE = [0xe6, 0xdf, 0xcd]; // the grain in the sheet
const INK = [0x2b, 0x2a, 0x28]; //   --text
const DRY = [0x8d, 0x88, 0x80]; //   where the brush ran out

// Everything is on a 512 grid and scaled to whatever size is asked for.
const C = 256; // centre
const R = 156; // the circle the brush travels

// Where the brush touches down and where it lifts, in degrees, measured the
// way a mathematician does — 0 at 3 o'clock, counter-clockwise positive. The
// stroke runs from START anti-clockwise the long way round to END.
//
// The gap sits at the top right, between one and two o'clock. It is not a
// notch cut out of a ring: it is the distance between where a hand began and
// where it stopped, which is why the two ends do not match.
const START = 80;
const END = 58 + 360;

// Everything stays within 200px of the centre, which is what survives the
// maskable crop to the middle 80%. R + the widest half-stroke is 152 + 15.
const WIDTH = [
  // t along the stroke, and how wide the brush is there. A brush set down
  // reaches its weight almost at once and carries it nearly the whole way;
  // only the lift is gradual. Spreading the taper across the second half
  // instead made the right side thin out early, which reads as the stroke
  // fading rather than as a hand finishing.
  [0.0, 3], //   touching down
  [0.03, 16],
  [0.1, 25],
  [0.3, 31],
  [0.55, 33], // through the bottom, bearing down
  [0.72, 31],
  [0.85, 27], // still full weight this late
  [0.93, 17],
  [0.98, 6],
  [1.0, 1], //   lifting: drawn out to nothing
];

/** How wide the brush is at t, straight-line between the points above. */
function widthAt(t) {
  for (let i = 1; i < WIDTH.length; i++) {
    const [t0, w0] = WIDTH[i - 1];
    const [t1, w1] = WIDTH[i];
    if (t <= t1) return w0 + ((w1 - w0) * (t - t0)) / (t1 - t0);
  }
  return WIDTH[WIDTH.length - 1][1];
}

/** The circle is not a circle. A hand does not close one, so this one wanders. */
const radiusAt = (deg) => {
  const a = (deg * Math.PI) / 180;
  return R + 3.4 * Math.sin(3 * a + 0.9) + 1.9 * Math.sin(5 * a + 2.3);
};

// Where the ink failed to take. Each is a place along the stroke (t), how far
// across it (-1 inner edge, +1 outer), and how big. Kasure: the mark of a
// brush moving faster than it can give up ink, and the reason a stroke reads
// as one movement rather than a shape that was filled in.
const DRAGGED = [
  { t: 0.17, across: -0.4, along: 0.022, wide: 0.34 },
  { t: 0.36, across: 0.36, along: 0.014, wide: 0.26 },
  { t: 0.52, across: 0.05, along: 0.018, wide: 0.22 },
  { t: 0.64, across: -0.5, along: 0.012, wide: 0.3 },
  { t: 0.78, across: 0.42, along: 0.02, wide: 0.28 },
  { t: 0.88, across: -0.28, along: 0.011, wide: 0.24 },
];

// The grain. Long, faint, and going nowhere in particular, which is what laid
// paper looks like when you hold it up. Each is a segment plus a half-width.
const GRAIN = [
  [30, 74, 205, 62, 0.9],
  [286, 40, 470, 96, 0.9],
  [12, 232, 150, 214, 0.8],
  [352, 196, 502, 176, 0.9],
  [60, 330, 176, 352, 0.8],
  [330, 300, 486, 286, 0.9],
  [24, 430, 214, 452, 0.9],
  [268, 470, 448, 440, 0.8],
  [150, 130, 280, 112, 0.7],
  [200, 396, 366, 414, 0.7],
];

// --- the drawing -------------------------------------------------------------

const TWO_PI = Math.PI * 2;

/**
 * Where a point falls on the stroke: how far along, and how far across.
 *
 * Returns null outside it. `across` is -1 at the inner edge and +1 at the
 * outer, which is what the dry patches are placed against.
 */
function onStroke(x, y) {
  const dx = x - C;
  const dy = C - y; // screen y grows downward; the angles above do not
  const dist = Math.hypot(dx, dy);
  if (dist < 40) return null; // the middle, which is the point of the thing

  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  while (deg < START) deg += 360;
  if (deg > END) return null; // in the gap

  const t = (deg - START) / (END - START);
  const half = widthAt(t) / 2;
  const off = dist - radiusAt(deg);
  if (Math.abs(off) > half) return null;

  return { t, across: off / half };
}

/** Coverage of one point by the grain, as a fraction. */
function grainAt(x, y) {
  let a = 0;
  for (const [x0, y0, x1, y1, half] of GRAIN) {
    const vx = x1 - x0;
    const vy = y1 - y0;
    const len = vx * vx + vy * vy;
    const u = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / len));
    const d = Math.hypot(x - (x0 + u * vx), y - (y0 + u * vy));
    if (d <= half) a = Math.max(a, 1 - d / half);
  }
  return a;
}

const mix = (under, over, a) => under.map((c, i) => Math.round(c + (over[i] - c) * a));

/** The colour at a point on the 512 grid. */
function paint(x, y) {
  const stroke = onStroke(x, y);
  if (!stroke) return mix(PAPER, FIBRE, grainAt(x, y) * 0.75);

  // Inside the ink. Did the brush actually leave any here?
  //
  // Measured in the stroke's own frame — how far ALONG and how far ACROSS —
  // rather than as a distance on the page. A patch is then an ellipse that
  // follows the curve, long in the direction of travel and narrow across it,
  // which is what a skipping brush leaves. Measured on the page they came out
  // as round dots, and round dots read as holes punched in a shape rather than
  // as ink that failed to take.
  for (const d of DRAGGED) {
    const along = (stroke.t - d.t) / d.along;
    const across = (stroke.across - d.across) / d.wide;
    const reach = Math.hypot(along, across);
    if (reach <= 1) return mix(INK, DRY, (1 - reach) * 0.85);
  }

  // The edge of a brushstroke is not a line. Fade the outermost sliver so the
  // ink meets the paper the way it does on paper.
  const edge = Math.min(1, (1 - Math.abs(stroke.across)) * 6);
  return mix(PAPER, INK, edge);
}

// --- the PNGs ----------------------------------------------------------------

const SS = 4; // four samples a side; 16 clears the curve at both sizes

function sample(px, py, scale) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const [pr, pg, pb] = paint(
        ((px + (sx + 0.5) / SS) / scale) * 512,
        ((py + (sy + 0.5) / SS) / scale) * 512
      );
      r += pr;
      g += pg;
      b += pb;
    }
  }
  const n = SS * SS;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = sample(x, y, size);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; //  8 bits per channel
  ihdr[9] = 2; //  truecolour, no alpha: the icon is fully opaque
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the SVG -----------------------------------------------------------------

const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const round = (n) => Math.round(n * 10) / 10;

/** The stroke as one closed outline: out along the far edge, back along the near. */
function inkPath() {
  const STEPS = 150;
  const outer = [];
  const inner = [];

  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const deg = START + t * (END - START);
    const a = (deg * Math.PI) / 180;
    const half = widthAt(t) / 2;
    const r = radiusAt(deg);
    outer.push([C + (r + half) * Math.cos(a), C - (r + half) * Math.sin(a)]);
    inner.push([C + (r - half) * Math.cos(a), C - (r - half) * Math.sin(a)]);
  }

  const pts = [...outer, ...inner.reverse()];
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${round(x)} ${round(y)}`).join('') + 'Z';
}

function svg() {
  const grain = GRAIN.map(
    ([x0, y0, x1, y1, half]) =>
      `    <line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke-width="${half * 2}"/>`
  ).join('\n');

  // The same ellipses, in the same stroke frame, walked round as short arcs so
  // each one curves with the brush rather than sitting on it as a circle.
  const dry = DRAGGED.map((d) => {
    const pts = [];
    for (let k = 0; k <= 20; k++) {
      const ang = (k / 20) * TWO_PI;
      const t = d.t + Math.cos(ang) * d.along;
      const across = d.across + Math.sin(ang) * d.wide;
      const deg = START + t * (END - START);
      const a = (deg * Math.PI) / 180;
      const r = radiusAt(deg) + (across * widthAt(t)) / 2;
      pts.push([C + r * Math.cos(a), C - r * Math.sin(a)]);
    }
    const d2 = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${round(x)} ${round(y)}`).join('');
    return `    <path d="${d2}Z"/>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <!-- GENERATED BY make-icons.js. Do not edit: run the generator.

       An ensō, open where the brush lifted — the same mark the app shows while
       it is loading. The stroke thickens through the bottom and is drawn out
       to nothing at the end, the circle wanders because a hand does not close
       one, and the pale patches are where the brush ran out of ink.

       This file used to be maintained by hand beside the generator and the two
       disagreed for months without anything noticing. Now there is one source
       and this is its output. -->
  <rect width="512" height="512" fill="${hex(PAPER)}"/>
  <g stroke="${hex(FIBRE)}" stroke-linecap="round" fill="none">
${grain}
  </g>
  <path fill="${hex(INK)}" d="${inkPath()}"/>
  <g fill="${hex(DRY)}">
${dry}
  </g>
</svg>
`;
}

// --- write -------------------------------------------------------------------

fs.writeFileSync('public/icon.svg', svg());
console.log(`public/icon.svg  ${fs.statSync('public/icon.svg').size} bytes`);

for (const size of [192, 512]) {
  const file = `public/icon-${size}.png`;
  fs.writeFileSync(file, png(size));
  console.log(`${file}  ${fs.statSync(file).size} bytes`);
}
