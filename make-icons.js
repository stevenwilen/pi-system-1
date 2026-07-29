// Write the home screen PNGs from the same shapes as public/icon.svg.
//
// Run: node make-icons.js
//
// There is no rasteriser on this machine and adding one would be a build
// dependency for two files that change once a year. The icon is a ground and
// two capsules, so they are drawn here directly and encoded as PNG with the
// zlib that ships with Node.
//
// This exists so the PNGs are reproducible. Without it they are two binaries
// nobody can explain or regenerate, and the SVG beside them slowly stops being
// the truth.

const fs = require('fs');
const zlib = require('zlib');

// The same values as the SVG, on its 512 grid, scaled to whatever size is
// asked for. Keep the two in step: this file is the SVG's twin, not its source.
const GROUND = [0x16, 0x13, 0x0f]; // --bg

// Every shape is a capsule: "within `half` of the segment from (x0,y) to
// (x1,y)". One primitive covers the whole drawing, and a circle is just this
// with x0 === x1 — which is what the old dot was, written out longhand.
//
// (x0, x1) are the SEGMENT's ends, so the drawn shape runs from x0-half to
// x1+half. The SVG's rects are derived from exactly that: x = x0 - half and
// width = (x1 - x0) + 2*half.
//
// Those two disagreed until now. The SVG read (x0, x1) as the outer edges of
// its rect and this file read them as the segment, so the PNG's bar was 18px
// longer at each end than the drawing it claims to be. Nothing caught it: the
// icon check samples at a quarter across, and both versions cover that.
//
// Painted in order, so a later shape sits over an earlier one.
const SHAPES = [
  // The day.
  { x0: 112, x1: 400, y: 256, half: 8, rgb: [0x8b, 0x81, 0x77] }, // --muted
  // A block sitting in it.
  { x0: 224, x1: 312, y: 256, half: 22, rgb: [0x6e, 0x8c, 0xb8] }, // --accent
];

// Four samples a side. Every shape is a capsule, so the only visible aliasing
// is on their curves, and 16 samples clears it at both sizes.
const SS = 4;

const mix = (under, over, a) => under.map((c, i) => Math.round(c + (over[i] - c) * a));

/** Coverage of one device pixel by each shape, supersampled. */
function sample(px, py, scale) {
  const hits = SHAPES.map(() => 0);

  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      // Centre of this subsample, back on the 512 grid.
      const x = ((px + (sx + 0.5) / SS) / scale) * 512;
      const y = ((py + (sy + 0.5) / SS) / scale) * 512;

      SHAPES.forEach((s, i) => {
        // The nearest point on the segment, then the distance to it.
        const cx = Math.min(Math.max(x, s.x0), s.x1);
        const dx = x - cx;
        const dy = y - s.y;
        if (dx * dx + dy * dy <= s.half * s.half) hits[i]++;
      });
    }
  }

  const total = SS * SS;
  let rgb = GROUND;
  SHAPES.forEach((s, i) => {
    if (hits[i]) rgb = mix(rgb, s.rgb, hits[i] / total);
  });
  return rgb;
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
  // Filter byte 0 (none) then RGB triples, one row at a time.
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
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

for (const size of [192, 512]) {
  const file = `public/icon-${size}.png`;
  fs.writeFileSync(file, png(size));
  console.log(`${file}  ${fs.statSync(file).size} bytes`);
}
