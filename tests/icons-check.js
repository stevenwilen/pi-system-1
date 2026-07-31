// The icons: every one referenced exists, every one present is referenced, and
// the PNGs really are the SVG.
//
// This project has twice shipped a manifest pointing at an icon that had been
// deleted, and twice carried an icon file nothing referenced. Neither fails
// loudly: the home screen just keeps whatever it cached.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const manifest = JSON.parse(fs.readFileSync(`${ROOT}/public/manifest.json`, 'utf8'));
const html = fs.readFileSync(`${ROOT}/public/index.html`, 'utf8');
const svg = fs.readFileSync(`${ROOT}/public/icon.svg`, 'utf8');

console.log('nothing points at a file that is not there');
{
  const referenced = new Set(manifest.icons.map((i) => i.src.replace(/^\//, '')));
  for (const m of html.matchAll(/(?:href|content)="\/([\w.-]+\.(?:png|svg))"/g)) {
    referenced.add(m[1]);
  }

  for (const file of referenced) {
    check(`${file} exists`, fs.existsSync(`${ROOT}/public/${file}`));
  }

  const onDisk = fs.readdirSync(`${ROOT}/public`).filter((f) => /\.(png|svg)$/.test(f));
  const orphans = onDisk.filter((f) => !referenced.has(f));
  check('and no icon sits there unreferenced', orphans.length === 0, orphans.join(', ') || 'none');
}

console.log('\nthe manifest is coherent');
{
  check('an svg for any size', manifest.icons.some((i) => i.sizes === 'any' && i.type === 'image/svg+xml'));
  check('192 and 512 pngs', [192, 512].every((s) => manifest.icons.some((i) => i.sizes === `${s}x${s}`)));
  check('one maskable', manifest.icons.some((i) => i.purpose === 'maskable'));

  // THE INSTALL COLOURS ARE THE PAPER. background_color paints the splash the
  // system shows while the page loads, and theme_color the status bar around
  // it. They were still the dark build's #16130F after the theme changed, so
  // installing gave a near-black splash that opened into a paper app — a flash
  // of the previous design on every cold start.
  const paper = '#f5f1e8';
  check('the theme colour is the app background',
    manifest.theme_color.toLowerCase() === paper, manifest.theme_color);
  check('the splash is the same paper',
    manifest.background_color.toLowerCase() === paper, manifest.background_color);
  check('and the page agrees',
    new RegExp(`name="theme-color" content="${paper}"`, 'i').test(html));

  // THE NAME IS IN FOUR PLACES and they have to agree, because each is read by
  // a different installer: Android takes short_name for the home screen and
  // name for the install prompt, iOS ignores the manifest entirely and reads
  // apple-mobile-web-app-title, falling back to <title>. Three of the four can
  // be right while the icon on the phone says something else.
  const NAME = 'Schedule';
  check('the manifest name', manifest.name === NAME, manifest.name);
  check('and its short name, which is what Android puts on the home screen',
    manifest.short_name === NAME, manifest.short_name);
  check('the page title, which is what iOS falls back to',
    new RegExp(`<title>${NAME}</title>`).test(html));
  check('and the iOS title, which is what iOS actually uses',
    new RegExp(`name="apple-mobile-web-app-title" content="${NAME}"`).test(html));
}

console.log('\nthe pngs are the svg');
{
  // The three colours the drawing is made of, read off the SVG rather than
  // written here, so the two cannot disagree silently.
  const fills = [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toLowerCase());
  check('the svg is three flat shapes', fills.length === 3, fills.join(' '));

  const [ground, line, mark] = fills;

  const decode = (file) => {
    const b = fs.readFileSync(file);
    check(`${path.basename(file)} is a png`, b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');

    const size = b.readUInt32BE(16);
    const parts = [];
    let off = 8;
    while (off < b.length) {
      const len = b.readUInt32BE(off);
      if (b.subarray(off + 4, off + 8).toString('ascii') === 'IDAT') {
        parts.push(b.subarray(off + 8, off + 8 + len));
      }
      off += 12 + len;
    }

    const raw = zlib.inflateSync(Buffer.concat(parts));
    const stride = size * 3 + 1;
    return {
      size,
      at: (x, y) => {
        const i = y * stride + 1 + x * 3;
        return '#' + [raw[i], raw[i + 1], raw[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      },
    };
  };

  for (const [file, want] of [['icon-192.png', 192], ['icon-512.png', 512]]) {
    const png = decode(`${ROOT}/public/${file}`);
    const mid = Math.round(png.size / 2);

    check(`${file} is ${want} square`, png.size === want, `${png.size}`);
    check(`  ground in the corner`, png.at(2, 2) === ground, `${png.at(2, 2)} against ${ground}`);
    check(`  the mark at the centre`, png.at(mid, mid) === mark, `${png.at(mid, mid)} against ${mark}`);
    check(`  the line either side of it`, png.at(Math.round(png.size * 0.25), mid) === line,
      `${png.at(Math.round(png.size * 0.25), mid)} against ${line}`);
    check(`  and ground above it`, png.at(mid, Math.round(png.size * 0.12)) === ground);

    // A maskable icon is masked to the middle 80%, so the mark has to survive
    // being cropped to it.
    const inset = Math.round(png.size * 0.1);
    check(`  the mark is inside the maskable safe area`,
      png.at(mid, mid + inset) !== ground || png.at(mid, mid) === mark);
  }

  check('the generator is kept, so they can be made again', fs.existsSync(`${ROOT}/make-icons.js`));
}

console.log(bad === 0 ? '\nIcons clean' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
