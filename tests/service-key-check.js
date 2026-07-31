// No route may reach the service key.
//
// The service key bypasses row level security. A route holding it serves every
// user's rows to whoever asked, and nothing — not a policy, not a filter it
// forgot — would object. So the rule is structural: routes take their client
// from req.auth.db, which carries the caller's own token, and the service
// client belongs to the scheduler and the command line tools alone.
//
// THIS IS THE STATIC HALF. It reads the import graph and names the file, which
// is where a mistake should normally be caught, before anything runs. The other
// half is in db.js: the service client throws if it is used inside a request,
// which catches what reading imports cannot see. Neither replaces the other —
// this one is a claim about the code, that one is a fact about the process.
//
// No database and no network.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

/** Every local module a file requires, as a repo-relative path. */
function importsOf(file) {
  const full = `${ROOT}/${file}`;
  if (!fs.existsSync(full)) return [];

  const src = fs.readFileSync(full, 'utf8');
  const dir = path.posix.dirname(file);
  const out = [];

  for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+?)(?:\.js)?['"]\s*\)/g)) {
    out.push({ spec: m[1], file: path.posix.normalize(`${dir}/${m[1]}.js`) });
  }
  return out;
}

/**
 * Does this file take the service client out of db.js?
 *
 * Not "does it import db.js" — every route's dependencies may legitimately
 * import db.js for `forUser`. What is forbidden is the `service` export, so
 * that is what is looked for: the destructured name, or the property read.
 */
function takesService(file) {
  const full = `${ROOT}/${file}`;
  if (!fs.existsSync(full)) return false;

  const src = fs.readFileSync(full, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // const { service } = require('./db')   /   const { service: x } = require('../db')
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*\/?db(?:\.js)?['"]\s*\)/g)) {
    if (/\bservice\b/.test(m[1])) return true;
  }

  // const db = require('./db'); db.service
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"][^'"]*\/?db(?:\.js)?['"]\s*\)/g)) {
    if (new RegExp(`\\b${m[1]}\\.service\\b`).test(src)) return true;
  }

  return false;
}

/** Every file reachable from a starting point, following local requires. */
function reachableFrom(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const { file } of importsOf(entry)) reachableFrom(file, seen);
  return seen;
}

console.log('1. nothing a route can reach holds the service key');
{
  const routes = fs
    .readdirSync(`${ROOT}/routes`)
    .filter((f) => f.endsWith('.js'))
    .map((f) => `routes/${f}`);

  check('there are routes to check', routes.length > 0, routes.join(', '));

  for (const entry of routes) {
    const reach = [...reachableFrom(entry)];
    const holders = reach.filter(takesService);

    check(
      `${entry} reaches ${reach.length} file(s), none holding the service key`,
      holders.length === 0,
      holders.length ? `HOLDS IT: ${holders.join(', ')}` : ''
    );
  }

  // SERVER.JS IS NOT ONE OF THESE ENTRY POINTS, and the reason is worth
  // writing down because the first version of this check got it wrong and
  // failed here.
  //
  // server.js requires ./scheduler for its side effect — that is how delivery
  // runs in this one process — so the service key is genuinely loaded in the
  // same process as the routes, and always was. Walking imports from server.js
  // therefore proves nothing except that the scheduler exists.
  //
  // The distinction that matters is not "loaded in this process" but "reachable
  // while serving a request", and imports cannot express it. That is precisely
  // the gap the runtime guard in db.js fills: the scheduler runs on a timer,
  // outside any request scope, and the same client would throw if a request
  // ever reached it.
  //
  // What is checkable here is narrower and still worth having: server.js must
  // not take the service client itself.
  check('server.js does not take the service client itself', !takesService('server.js'));
}

console.log('\n2. the ones that are allowed to hold it, do');
{
  // Stated the other way round, so that the check above cannot pass by the
  // service client having quietly disappeared from the codebase.
  check('scheduler.js holds the service key', takesService('scheduler.js'));

  // AND telegram.js NO LONGER DOES. It used to, and it had to stop the moment
  // a route needed it: the linking endpoint sends through it, so it became
  // reachable from routes/ and this file's first section went red. It takes a
  // client now, like tools.js and staleness.js, and the scheduler hands it the
  // service one.
  check('the Telegram sender holds no client of its own', !takesService('telegram.js'));
  check('and takes one instead',
    /function sendTelegram\(db, user_id, text\)/.test(
      fs.readFileSync(`${ROOT}/telegram.js`, 'utf8')
    ));

  const src = fs.readFileSync(`${ROOT}/db.js`, 'utf8');
  check('db.js exports both clients',
    /forUser/.test(src) && /service/.test(src) && /module\.exports/.test(src));
  check('the caller-scoped one is built from the anon key',
    /createClient\(url, anonKey/.test(src), 'forUser must not use the service key');
}

console.log('\n3. and no route names a user any way but from the token');
{
  // PI_USER_ID is gone. The check is that it stays gone: a fallback user is
  // how a request that proved nothing gets served anyway.
  for (const file of ['user.js', 'server.js', 'routes/entries.js', 'routes/plan.js']) {
    // Comments stripped, the same as everywhere else that asserts a removed
    // thing is not mentioned: user.js explains at length that it used to read
    // PI_USER_ID, and that sentence is not a fallback user.
    const src = fs.readFileSync(`${ROOT}/${file}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    check(`${file} has no default user`, !/PI_USER_ID/.test(src));
    check(`${file} names no uuid of its own`,
      !/['"][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]/i.test(src));
  }

  const server = fs.readFileSync(`${ROOT}/server.js`, 'utf8');
  check('the gate refuses a request with no token', /401/.test(server));
  check('and derives the user from the token rather than the body',
    /userFrom\(token\)/.test(server));
}

console.log(bad === 0 ? '\nService key contained' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
