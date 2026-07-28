// Every suite, in order, one at a time.
//
// Sequential on purpose: they share one test user, and two of them writing the
// same rows at once would fail for a reason that has nothing to do with the
// code under test.
const { spawn } = require('child_process');
const fs = require('fs');
const S = __dirname;

const REAL_USER = '00000000-0000-0000-0000-000000000001';

// The app is the directory above this one. Found rather than written down, so
// the suites run from any clone on any machine.
const APP = require('path').join(__dirname, '..').replace(/\\/g, '/');

/**
 * Does importing this app module put a database client in reach?
 *
 * Resolved rather than assumed. sheet.js and money.js are arithmetic and HTTP
 * and cannot touch a row however they are called; coldness.js reaches db.js
 * through two hops. A hardcoded list of "dangerous files" would be wrong the
 * first time one of them grew an import, so the answer is computed.
 */
const reachesDb = (file, seen = new Set()) => {
  if (seen.has(file)) return false;
  seen.add(file);

  const path = `${APP}/${file}`;
  if (!fs.existsSync(path)) return false;
  if (/^db\.js$/.test(file)) return true;

  const src = fs.readFileSync(path, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+?)(?:\.js)?['"]\s*\)/g)) {
    if (reachesDb(`${m[1]}.js`, seen)) return true;
  }
  return false;
};

/**
 * Refuse to run anything that could write to the real person's rows.
 *
 * The guard in harness.js only guards what goes through harness.js. A suite
 * that requires db.js directly, or names the real user id, never meets it —
 * which is exactly what task-test.js did, silently, on every run, for as long
 * as it was in this list.
 *
 * So the check is here instead, before anything is spawned, and it reads the
 * file rather than trusting the file to behave. A suite that writes must import
 * the harness, and no suite may name the real id at all.
 */
function refuseUnguarded(names) {
  const problems = [];

  for (const name of names) {
    const path = `${S}/${name}`;
    if (!fs.existsSync(path)) {
      problems.push(`${name}: not found`);
      continue;
    }

    const src = fs.readFileSync(path, 'utf8');

    const guarded = src.includes("require('./harness')");

    // Which app modules this suite pulls in, and whether any of them can see
    // the database once it is loaded.
    const imported = [...src.matchAll(/require\(\s*ROOT\s*\+\s*['"]\/([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    const dbInReach = imported.filter((f) => reachesDb(f));

    const spawnsServer = /\['server\.js'\]|spawn\([^)]*server\.js/.test(src);
    const pointsAtTestUser = src.includes('PI_USER_ID');

    if (src.includes(REAL_USER)) {
      problems.push(`${name}: names the real user id`);
    } else if (dbInReach.length && !guarded) {
      problems.push(`${name}: loads ${dbInReach.join(', ')}, which reaches the database, without the harness`);
    } else if (spawnsServer && !guarded && !pointsAtTestUser) {
      problems.push(`${name}: starts a server without pointing it at the test user`);
    }
  }

  if (problems.length) {
    console.error('REFUSING TO RUN. These could reach real rows:\n  ' + problems.join('\n  '));
    process.exit(2);
  }
}

// Four files were deleted rather than skipped: schema-test.js and
// finance-test.js required a finance.js removed in the rebuild, api-test.js hit
// an endpoint that no longer exists, and guard-test.js predated the test user
// and wrote against the real id. A suite that cannot run still reads as
// coverage, which is worse than having no file there at all.
const SUITES = [
  // read-only, fast
  ['sheet-contract.js', 90],
  ['money-test.js', 60],
  ['calendar-endpoint-test.js', 120],
  ['calendar-feeds-test.js', 180],
  ['builder-test.js', 120],
  ['task-test.js', 120],
  ['tasks-render-test.js', 120],
  ['money-order-test.js', 120],
  ['stale-render-check.js', 120],
  ['plan-layout-check.js', 120],
  ['summarize-test.js', 120],
  ['icons-check.js', 60],
  // guarded writers
  ['verify-isolation.js', 120],
  ['due-test.js', 180],
  ['plan-intent-test.js', 180],
  ['nudge-test.js', 180],
  ['step1-verify.js', 150],
  ['intent-test.js', 180],
  ['setup-test.js', 180],
  ['plan-test.js', 180],
  ['review-test.js', 180],
  ['delivery-test.js', 240],
  // these call the model for real
  ['messages-test.js', 300],
  ['order-cold-test.js', 300],
  ['no-repeat-test.js', 300],
  ['insight-test.js', 300],
  ['injection-test.js', 300],
];

const only = process.argv.slice(2);
const list = only.length ? SUITES.filter(([n]) => only.includes(n)) : SUITES;

refuseUnguarded(list.map(([n]) => n));

const run = (name, secs) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [`${S}/${name}`], {
      cwd: APP,
      env: { ...process.env, SCHEDULER_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));

    const timer = setTimeout(() => {
      p.kill();
      resolve({ name, code: 'TIMEOUT', out });
    }, secs * 1000);

    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, code, out });
    });
  });

(async () => {
  const results = [];
  for (const [name, secs] of list) {
    const started = Date.now();
    const r = await run(name, secs);
    r.secs = Math.round((Date.now() - started) / 1000);
    results.push(r);

    const ok = r.code === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${String(r.secs).padStart(3)}s  exit=${r.code}`);
    if (!ok) {
      const lines = r.out.split('\n').filter((l) => l.trim());
      console.log(lines.slice(-25).map((l) => '      | ' + l).join('\n'));
    }
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
  if (failed.length) console.log('failed: ' + failed.map((r) => r.name).join(', '));
  process.exit(failed.length ? 1 : 0);
})();
