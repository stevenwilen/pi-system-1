// Write the home screen PNGs from the same shapes as public/icon.svg.
//
// Run: node make-icons.js
//
// There is no rasteriser on this machine and adding one would be a build
// dependency for two files that change once a year. The icon is three flat
// shapes, so they are drawn here directly and encoded as PNG with the zlib that
// ships with Node.
//
// This exists so the PNGs are reproducible. Without it they are two binaries
// nobody can explain or regenerate, and the SVG beside them slowly stops being
// the truth.

const fs = require('fs');
const zlib = require('zlib');

// The same values as the SVG, on its 512 grid, scaled to whatever size is
// asked for. Keep the two in step: this file is the SVG's twin, not its source.
const GROUND = [0x16, 0x13, 0x0f]; // --bg
const LINE = [0x8b, 0x81, 0x77]; //   --muted
const MARK = [0xe0, 0xa4, 0x58]; //   --amber

const BAR = { x0: 112, x1: 400, cy: 256, half: 9 };
const DOT = { cx: 256, cy: 256, r: 44 };

// Four samples a side. The shapes are a capsule and a circle, so the only
// visible aliasing is on their curves, and 16 samples clears it at both sizes.
const SS = 4;

const mix = (under, over, a) => under.map((c, i) => Math.round(c + (over[i] - c) * a));

/** Coverage of one device pixel by the two shapes, supersampled. */
function sample(px, py, scale) {
  let inBar = 0;
  let inDot = 0;

  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      // Centre of this subsample, back on the 512 grid.
      const x = ((px + (sx + 0.5) / SS) / scale) * 512;
      const y = ((py + (sy + 0.5) / SS) / scale) * 512;

      // The bar is a capsule: a rectangle with a half-disc at each end, which
      // is the same as "within `half` of the segment between its two ends".
      const cx = Math.min(Math.max(x, BAR.x0), BAR.x1);
      const dx = x - cx;
      const dy = y - BAR.cy;
      if (dx * dx + dy * dy <= BAR.half * BAR.half) inBar++;

      const ex = x - DOT.cx;
      const ey = y - DOT.cy;
      if (ex * ex + ey * ey <= DOT.r * DOT.r) inDot++;
    }
  }

  const total = SS * SS;
  let rgb = GROUND;
  if (inBar) rgb = mix(rgb, LINE, inBar / total);
  // The mark sits over the line, so it is composited last.
  if (inDot) rgb = mix(rgb, MARK, inDot / total);
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
