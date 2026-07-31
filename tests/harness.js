// Test isolation, enforced rather than agreed.
//
// A test that writes gets a database handle that physically cannot write to
// anyone but the test accounts. Not a naming convention, not a review habit:
// an insert without a test account's id in the payload, or an update or delete
// without it in the filter, throws before it reaches the network.
//
// This exists because scoping lookups by hand failed. A suite written when the
// notebook was empty searched by kind, matched the owner's rows once real ones
// existed, and edited and deleted them. Every future test would have had to
// remember; this one does not depend on remembering.
//
// TWO ACCOUNTS NOW, AND THEY ARE REAL. There used to be one id, a constant,
// belonging to nobody — which was fine while the server took its identity from
// an environment variable. It cannot work now: routes derive the user from a
// verified token, and no token can be minted for a uuid that is not an auth
// user. So the suite creates two actual accounts, signs into both, and holds
// their tokens. Their ids are discovered at runtime and written down nowhere.

const { spawn } = require('child_process');

// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

const { service, forUser, requestScope, url: SUPABASE_URL, anonKey } = require(ROOT + '/db.js');

// Synthetic, and deliberately on a domain that can never receive mail.
// `email_confirm` is set when they are created, so whether this project asks
// for confirmation is not something the suite depends on.
const ACCOUNTS = [
  { key: 'a', email: 'pi-suite-a@example.test', password: 'suite-password-a-9f2c' },
  { key: 'b', email: 'pi-suite-b@example.test', password: 'suite-password-b-4d81' },
];

const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

class TestUserViolation extends Error {}

/**
 * The ids a write is allowed to touch.
 *
 * Empty until setup() has run, and that is the useful default: a suite that
 * writes before it has any accounts is refused rather than trusted. There is
 * no id in this file to fall back to.
 */
const allowed = new Set();

function refuse(detail) {
  throw new TestUserViolation(
    `BLOCKED: a write-capable test tried to touch rows outside the test accounts.\n` +
      `  ${detail}\n` +
      `  test accounts: ${[...allowed].join(', ') || '(none yet — call H.setup() first)'}\n` +
      `  Every insert must carry one of those user_ids, and every update or\n` +
      `  delete must filter on one. This is the guard, not a warning: nothing\n` +
      `  was written.`
  );
}

function checkPayload(table, payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  for (const [i, row] of rows.entries()) {
    if (!row || typeof row !== 'object') continue;
    // Tables without a user_id of their own are reached through their parent,
    // which is itself guarded, so they are not second-guessed here.
    if (!('user_id' in row)) {
      if (table === 'entries' || table === 'profile' || table === 'plans') {
        refuse(`insert into ${table} row ${i + 1} has no user_id at all`);
      }
      continue;
    }
    if (!allowed.has(row.user_id)) {
      refuse(`insert into ${table} row ${i + 1} carries user_id ${row.user_id}`);
    }
  }
}

/**
 * Wraps a query builder, remembering the filters as they are chained and
 * checking them at execution rather than at call time.
 *
 * supabase-js builds `.update({...}).eq('user_id', x)`, so the filter arrives
 * after the verb. Validating when `update` is called would see nothing and
 * pass everything.
 */
function wrap(builder, state) {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      // Awaiting the chain is the last moment before it executes.
      if (prop === 'then') {
        if (state.write && !state.payloadChecked && !allowed.has(state.user)) {
          refuse(
            `${state.write} on ${state.table} filtered by user_id=${state.user === undefined ? '(nothing)' : state.user}`
          );
        }
        const then = target.then;
        return typeof then === 'function' ? then.bind(target) : then;
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      return (...args) => {
        if ((prop === 'eq' || prop === 'match') && args[0] === 'user_id') {
          state.user = args[1];
        }
        if (prop === 'match' && args[0] && typeof args[0] === 'object' && 'user_id' in args[0]) {
          state.user = args[0].user_id;
        }

        if (WRITES.has(prop)) {
          state.write = prop;
          if (prop === 'insert' || prop === 'upsert') {
            // An insert names its own user, so it is checked immediately and
            // needs no filter afterwards.
            checkPayload(state.table, args[0]);
            state.payloadChecked = true;
          }
        }

        const result = value.apply(target, args);
        return result && typeof result === 'object' ? wrap(result, state) : result;
      };
    },
  });
}

// The guarded handle. Reads pass through untouched; writes are checked.
//
// This is the SERVICE client underneath, so it still bypasses row level
// security — which is exactly why the guard is still here. Setup and teardown
// need to reach across accounts; the policies will not stop them, so this does.
const db = {
  from(table) {
    return wrap(service.from(table), { table, user: undefined, write: null, payloadChecked: false });
  },
};

// --- the accounts -------------------------------------------------------------

let ready = null;

/** Sign in, and hand back what the browser would have held. */
async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(`could not sign in as ${email}: ${body.error_description || body.msg || JSON.stringify(body)}`);
  }
  return body.access_token;
}

/**
 * The account, created if this is the first run and reused ever after.
 *
 * Reused rather than made fresh each time on purpose: a suite that minted new
 * accounts every run would leave a growing pile of them in the project, and
 * the ones it left behind would own rows nothing would ever clean up.
 */
async function ensureAccount({ email, password }) {
  const made = await service.auth.admin.createUser({
    email,
    password,
    // Set here so the suite does not depend on the project's confirmation
    // setting, which is a toggle someone may reasonably change later.
    email_confirm: true,
  });

  if (made.data && made.data.user) return made.data.user.id;

  // Already there from a previous run. `listUsers` is paged; the filter is
  // done here because the admin API has no lookup by email.
  const message = (made.error && made.error.message) || '';
  if (!/already|registered|exists/i.test(message)) {
    throw new Error(`could not create ${email}: ${message}`);
  }

  for (let page = 1; page <= 20; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`could not list users: ${error.message}`);
    const found = (data.users || []).find((u) => u.email === email);
    if (found) return found.id;
    if (!data.users || data.users.length < 200) break;
  }

  throw new Error(`${email} is registered but could not be found`);
}

/**
 * Both accounts, signed in, memoised for the life of the process.
 *
 * Nothing else in the suite may write until this has run, because the write
 * guard has no ids to allow until it does.
 */
async function setup() {
  if (ready) return ready;

  ready = (async () => {
    const out = {};
    for (const spec of ACCOUNTS) {
      const id = await ensureAccount(spec);
      const token = await signIn(spec.email, spec.password);
      allowed.add(id);
      out[spec.key] = {
        id,
        email: spec.email,
        token,
        // The account's own connection: anon key under their token, exactly
        // what a route builds. Subject to row level security, which is the
        // whole point of having one here.
        db: forUser(token),
        headers: { Authorization: `Bearer ${token}` },
      };
    }
    return out;
  })();

  return ready;
}

/** The first account's id — what the older suites mean by "the test user". */
async function userId() {
  return (await setup()).a.id;
}

/** fetch, as somebody. */
function as(account) {
  return (url, opts = {}) =>
    fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...account.headers } });
}

/**
 * A throwaway account that is deleted while its token is still in hand.
 *
 * The only way this suite can produce a token that WAS genuinely valid and is
 * genuinely not any more. Clock expiry would mean either waiting an hour or
 * signing a JWT, and the project's signing secret is not something the suite
 * has — so this is revocation rather than expiry, and the auth suite says so
 * where it uses it.
 */
async function deadToken() {
  const email = `pi-suite-dead-${Date.now()}@example.test`;
  const password = 'suite-password-dead-77b3';

  const made = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (!made.data || !made.data.user) {
    throw new Error(`could not create the throwaway account: ${(made.error || {}).message}`);
  }

  const token = await signIn(email, password);
  const { error } = await service.auth.admin.deleteUser(made.data.user.id);
  if (error) throw new Error(`could not delete the throwaway account: ${error.message}`);

  return { token, id: made.data.user.id };
}

// --- servers ------------------------------------------------------------------

/**
 * A server. It has no user of its own any more.
 *
 * It used to be handed PI_USER_ID so that a suite driving HTTP could not reach
 * the owner's rows. That is not how it is kept honest now: the server serves
 * whoever the request's token says, so a suite reaches only the accounts it
 * holds tokens for, and holding no token reaches nothing at all.
 */
function spawnServer(port, extraEnv = {}) {
  return spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SCHEDULER_DISABLED: '1',
      ...extraEnv,
    },
    // No pipes, deliberately.
    //
    // Nothing that spawns through here reads the server's output, so the pipes
    // existed only to be torn down — and tearing them down is what aborted the
    // process. A suite that called process.exit() straight after server.kill()
    // was closing a handle libuv was already closing, which raises a native
    // assertion and a garbage exit code, so a run where every check passed was
    // reported as a failure. It surfaced as one flaky suite, but it was
    // whichever suite lost that race on the day.
    //
    // Inheriting instead means there is no handle to race over. The two suites
    // that genuinely read server output spawn their own child and handle their
    // own teardown.
    stdio: 'ignore',
  });
}

/**
 * Wait for it to answer.
 *
 * `/version` rather than `/entries`, because /entries needs a token now and
 * "is it listening" is a different question from "will it serve me". Any
 * answer at all means the port is up.
 */
async function waitFor(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(base + '/version');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

// Anything that reads a timezone needs a profile for that account.
//
// Written with the service handle: profile rows are created by nothing in the
// app, so there is no route that would make one, and the account has to have
// one before it can be served at all.
async function ensureProfile(timezone = 'America/New_York', wake = '08:00:00', which = 'a') {
  const accounts = await setup();
  const account = accounts[which];

  const { data } = await service
    .from('profile')
    .select('user_id')
    .eq('user_id', account.id)
    .maybeSingle();
  if (data) return;

  await db.from('profile').insert({
    user_id: account.id,
    timezone,
    default_wake_time: wake,
    telegram_chat_id: null,
  });
}

/**
 * Set fields on a test account's profile row, creating it if it is not there.
 *
 * This is how a suite configures a calendar now. It used to be done by handing
 * a spawned server different environment variables, which meant one server
 * process per feed configuration — three of them in calendar-feeds-test alone.
 * The feeds live on the row, so the row is what changes, and one server serves
 * every case.
 */
async function setProfile(which, fields) {
  const accounts = await setup();
  const account = accounts[which];

  await ensureProfile(undefined, undefined, which);

  const { error } = await db
    .from('profile')
    .update(fields)
    .eq('user_id', account.id);

  if (error) throw new Error(`could not set the ${which} profile: ${error.message}`);
}

/**
 * Remove everything belonging to the test accounts, and nothing else.
 *
 * Filtered on a test id in every statement, so even the teardown cannot reach
 * past its own rows.
 */
async function cleanup() {
  const accounts = await setup();
  for (const account of Object.values(accounts)) {
    // plans first: blocks cascade from them.
    for (const table of ['blocks', 'plans', 'entries', 'sent_log', 'messages', 'api_usage', 'profile']) {
      const { error } = await db.from(table).delete().eq('user_id', account.id);
      if (error && !/does not exist/i.test(error.message)) {
        console.error(`[harness] could not clear ${table}: ${error.message}`);
      }
    }
  }
}

/**
 * Proves the guard is live. Called at the top of every write-capable suite, so
 * a suite that somehow imported the unguarded client fails immediately rather
 * than at the moment it does damage.
 */
async function assertGuarded() {
  // Deliberately does NOT call setup().
  //
  // The guard is live whether or not there are accounts yet — with none, the
  // allowed set is empty and every write is refused, which is the strictest it
  // ever gets. Making this sign in would put a network round trip and a pair
  // of credentials in front of suites that only want to know the guard is
  // there: fence-test loads brain.js, which puts a client in reach, and calls
  // this for that reason alone. It has no rows and wants none.

  // Not one of the accounts, and not anybody: a uuid that exists to be refused.
  const OUTSIDER = '00000000-0000-0000-0000-0000000000ff';

  const attempts = [
    ['insert for someone else', () => db.from('entries').insert({ user_id: OUTSIDER, type: 'task', title: 'x' })],
    ['insert with no user at all', () => db.from('entries').insert({ type: 'task', title: 'x' })],
    ['update filtered only by id', () => db.from('entries').update({ title: 'x' }).eq('id', 'some-id')],
    ['delete filtered only by id', () => db.from('entries').delete().eq('id', 'some-id')],
    ['update aimed at someone else', () => db.from('entries').update({ title: 'x' }).eq('user_id', OUTSIDER)],
  ];

  for (const [label, run] of attempts) {
    let blocked = false;
    try {
      await run();
    } catch (err) {
      blocked = err instanceof TestUserViolation;
      if (!blocked) throw err;
    }
    if (!blocked) {
      throw new Error(`GUARD IS NOT WORKING: "${label}" was allowed through. Refusing to run.`);
    }
  }
}

module.exports = {
  ROOT,
  SUPABASE_URL,
  anonKey,
  setup,
  userId,
  as,
  deadToken,
  db,
  service,
  forUser,
  requestScope,
  spawnServer,
  waitFor,
  ensureProfile,
  setProfile,
  cleanup,
  assertGuarded,
  TestUserViolation,
};
