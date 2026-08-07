// Every suite, in order, one at a time.
//
// Sequential on purpose: they share one test user, and two of them writing the
// same rows at once would fail for a reason that has nothing to do with the
// code under test.
const { spawn } = require('child_process');
const fs = require('fs');
const S = __dirname;

// A uuid that could belong to a real account.
//
// No suite has a reason to name one: the accounts are real auth users, the
// harness creates them, and their ids are discovered at runtime. This used to
// name a single forbidden id — the owner's — which stopped meaning anything
// the moment ids stopped being constants, and would have gone on passing
// while a suite hardcoded somebody else's.
//
// The `00000000-0000-0000-0000-` prefix is exempt, and only that prefix. It is
// what this codebase has always used for ids that stand for nobody: the "this
// row does not exist" paths the auth suite drives, and the outsider the write
// guard proves it refuses. An id Supabase issues is random and cannot look
// like that, so exempting it gives up nothing.
const REAL_LOOKING_UUID =
  /['"](?!00000000-0000-0000-0000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]/i;

// The app is the directory above this one. Found rather than written down, so
// the suites run from any clone on any machine.
const APP = require('path').join(__dirname, '..').replace(/\\/g, '/');

/**
 * Does importing this app module put a database client in reach?
 *
 * Resolved rather than assumed. warning.js and clock.js are arithmetic and
 * cannot touch a row however they are called; routes/entries.js reaches db.js
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
    // Comments stripped: several suites explain at length which id they no
    // longer name, and an explanation is not a hardcoded id.
    const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    if (REAL_LOOKING_UUID.test(bare)) {
      problems.push(`${name}: names a uuid that could be a real account's. Ids come from the harness now.`);
    } else if (dbInReach.length && !guarded) {
      problems.push(`${name}: loads ${dbInReach.join(', ')}, which reaches the database, without the harness`);
    } else if (spawnsServer && !guarded) {
      // A server serves whoever the token says. A suite driving one without
      // the harness holds no tokens, so it reaches nothing — which reads as a
      // passing test about an empty account.
      problems.push(`${name}: starts a server without the harness, so it has no account to be`);
    }
  }

  if (problems.length) {
    console.error('REFUSING TO RUN. These could reach real rows:\n  ' + problems.join('\n  '));
    process.exit(2);
  }
}

// Suites are deleted rather than skipped when the thing they covered is
// removed. A suite that cannot run still reads as coverage, which is worse
// than having no file there at all.
//
// Thirteen went in the strip. sheet-contract, money-test, money-order-test,
// intent-test and insight-test were the finance lane. order-cold-test and
// injection-test drove the coldness call, no-repeat-test the finance one, and
// there are no model calls left for any of them to make. setup-test and
// plan-intent-test were the two setup interviews, summarize-test the
// Summarize endpoint, stale-render-check the temperature bar, and
// tasks-render-test a Monday digest that had already stopped existing.
//
// There is no "these call the model for real" group any longer. Nothing in
// this system calls it.
const SUITES = [
  // read-only, fast
  ['warning-test.js', 60],
  ['fence-test.js', 60],
  ['builder-test.js', 120],
  ['plan-layout-check.js', 120],
  ['icons-check.js', 60],
  ['service-key-check.js', 60],
  ['request-scope-check.js', 60],
  ['calendar-endpoint-test.js', 120],
  ['calendar-feeds-test.js', 180],
  ['task-test.js', 120],
  // guarded writers
  ['verify-isolation.js', 120],
  ['due-test.js', 180],
  ['nudge-test.js', 180],
  ['later-test.js', 180],
  ['loose-test.js', 180],
  ['done-test.js', 180],
  ['step1-verify.js', 150],
  ['plan-test.js', 180],
  ['note-test.js', 180],
  ['messages-test.js', 180],
  ['delivery-test.js', 240],
  ['telegram-link-test.js', 180],
  ['settings-test.js', 240],
  // The two this whole change exists for. Last, because they are the slowest
  // and the most likely to be the reason a run is being watched.
  ['auth-test.js', 180],
  ['isolation-accounts-test.js', 300],
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

      // THE FAILING LINES FIRST, then the tail. It was the tail alone, and
      // three separate intermittent failures were reported as twenty-five
      // consecutive PASSes — because a suite that fails early and then carries
      // on ends on its successes, and the last twenty-five lines are precisely
      // where the answer is not. Each time the only way to find out what broke
      // was to run the suite again, by which point it had stopped breaking.
      const failed = lines.filter((l) => /\bFAIL\b|harness error|Error:/.test(l));
      const tail = lines.slice(-12);
      const shown = [...failed, ...(failed.length ? ['      ...'] : []), ...tail];

      console.log(shown.map((l) => '      | ' + l).join('\n'));
    }
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
  if (failed.length) console.log('failed: ' + failed.map((r) => r.name).join(', '));
  process.exit(failed.length ? 1 : 0);
})();
