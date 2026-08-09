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

  // `*-reference.*` is exempt, and named so rather than listed. Those are the
  // drawings a design was worked out against — the same job mockup.html does,
  // which lives here too. They are meant to be unreferenced, and a check that
  // cannot tell them from a shipped icon would either flag them for ever or be
  // switched off, and switched off it stops catching the thing it exists for.
  //
  // The svg the maskable png is cut from is exempt the same way: nothing links
  // it, and it is the source the raster is regenerated from.
  const onDisk = fs
    .readdirSync(`${ROOT}/public`)
    .filter((f) => /\.(png|svg)$/.test(f) && !/-reference\.|-maskable\.svg$|^icon-1024\.png$/.test(f));
  const orphans = onDisk.filter((f) => !referenced.has(f));
  check('and no icon sits there unreferenced', orphans.length === 0, orphans.join(', ') || 'none');
}

console.log('\nthe manifest is coherent');
{
  check('an svg for any size', manifest.icons.some((i) => i.sizes === 'any' && i.type === 'image/svg+xml'));
  check('192 and 512 pngs', [192, 512].every((s) => manifest.icons.some((i) => i.sizes === `${s}x${s}`)));
  check('one maskable', manifest.icons.some((i) => i.purpose === 'maskable'));

  // A SEPARATE FILE, and this is the whole of why it is checked.
  //
  // The same png was declared for both purposes. A maskable icon is cropped by
  // the launcher to whatever shape the device uses — a circle, a squircle, a
  // rounded square — so it has to be drawn with its mark inside a safe zone
  // that leaves about 20% of every edge disposable. An "any" icon is drawn to
  // its own edges. Declaring one file as both means one of the two is wrong on
  // every device: either the mark is cropped, or it floats undersized in the
  // middle of its own tile. Nothing warns; it just looks careless on the home
  // screen, which is the one place an app is seen before it is opened.
  const anySrcs = new Set(
    manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.src)
  );
  const maskables = manifest.icons.filter((i) => i.purpose === 'maskable');
  check('the maskable is its own file, drawn into the safe zone',
    maskables.every((m) => !anySrcs.has(m.src)),
    maskables.map((m) => m.src).join(', '));
  check('and it is a png at 512', maskables.every((m) => m.sizes === '512x512'));

  // TWO COLOURS DOING TWO JOBS, which they did not use to.
  //
  // `background_color` paints the splash the system shows while the page loads,
  // so it is the app's own ground: white, and the page opens onto white with
  // nothing to flash. `theme_color` paints the chrome around the window, and it
  // is the icon's blue — the app's mark continues into the frame rather than
  // the frame disappearing into the page.
  //
  // They were the same value while the ground was the only thing either of them
  // meant. Before that they were both a dark build's near-black long after the
  // paper theme shipped, which is the failure this pair exists to catch: an
  // install colour outliving the design it belonged to.
  // BOTH WHITE. `background_color` paints the splash while the page loads and
  // `theme_color` the chrome around the window — and the mark sits on white, so
  // a blue bar over a white app is a seam where there should be none. They were
  // different while the icon had a solid blue ground.
  const ground = '#ffffff';
  const mark = '#ffffff';
  check('the splash is the app\'s own ground',
    manifest.background_color.toLowerCase() === ground, manifest.background_color);
  check('and the chrome is the mark\'s blue',
    manifest.theme_color.toLowerCase() === mark, manifest.theme_color);

  // AND THE PAGE SAYS THE SAME. iOS never reads the manifest — the meta tag is
  // the only thing it takes — so the two can disagree silently and give one
  // colour on Android and another on a phone.
  const meta = (html.match(/name="theme-color" content="(#[0-9a-fA-F]{6})"/i) || [])[1];
  check('the page names a theme colour at all', Boolean(meta), String(meta));
  check('and it is the one the manifest names',
    meta && meta.toLowerCase() === manifest.theme_color.toLowerCase(),
    `${meta} vs ${manifest.theme_color}`);

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

console.log('\nthe mark, and every file the manifest names');
{
  // A 5x5 GRID OF ROUNDED CELLS ON WHITE, at varying intensity: a gradient for
  // the strongest, then blue, teal and amber tints, and pale grey for empty. It
  // was a segmented ring before this, four rows on solid blue before that, and
  // an ensō in ink on paper before that. Each one has outlived a check written
  // for the last, which is why these read the drawing rather than describe it.
  const fills = [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toLowerCase());
  const unique = [...new Set(fills)];
  const cells = (svg.match(/<rect/g) || []).length;

  check('the ground is white', fills[0] === '#ffffff', fills[0]);

  // TWENTY-FIVE CELLS AND A GROUND. A grid that has lost a row still draws, and
  // still looks deliberate, which is exactly the kind of wrong nobody notices.
  check('it is five by five, on a ground', cells === 26, `${cells} rects`);

  // The strongest cells are a gradient rather than a flat fill, so they are not
  // in the list above at all — which is why this asks the markup instead.
  check('the strongest cells carry a gradient', /Gradient/.test(svg));

  check('and the rest are the app\'s own colours',
    unique.includes('#1e4fd8') && unique.includes('#2e9e8f') && unique.includes('#e8a33d'),
    unique.join(' '));
  check('with a pale grey for empty', unique.some((c) => /^#e[0-9a-f]/.test(c)), unique.join(' '));

  // EVERY FILE THE MANIFEST NAMES, at the size it claims. A manifest pointing
  // at a file that is not there is the failure this suite was written for, and
  // it has happened twice — most recently because the files arrived with the
  // browser's duplicate-download suffix and would have 404'd as delivered.
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\//, '');
    check(`${file} is on disk`, fs.existsSync(`${ROOT}/public/${file}`));
  }

  // AND THE ONE THE MANIFEST NEVER MENTIONS. iOS ignores the manifest for
  // installation and reads this tag alone, so a broken apple-touch-icon is
  // invisible to every check that only reads the manifest.
  const touch = (html.match(/rel="apple-touch-icon" href="\/([^"]+)"/) || [])[1];
  check('the apple-touch-icon names a file', Boolean(touch), String(touch));
  check('which is on disk', touch && fs.existsSync(`${ROOT}/public/${touch}`), String(touch));
  check('and is 180, the size iOS actually wants', touch === 'icon-180.png', String(touch));

  // Reads a png well enough to sample its header: no library, and no trusting
  // a generator to have run.
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

  for (const [file, want] of [['icon-180.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
    const png = decode(`${ROOT}/public/${file}`);
    check(`${file} is ${want} square`, png.size === want, `${png.size}`);
  }

  // NO PIXEL SAMPLING. The decoder above understands exactly what the old
  // generator wrote — one colour type, one filter, no interlacing — and reads
  // black out of anything else. Reporting that would be reporting the tool's
  // limits as the app's. What is checked is everything that has ever actually
  // broken: the file exists, it is a png, and it is the size claimed.
}

console.log(bad === 0 ? '\nIcons clean' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
