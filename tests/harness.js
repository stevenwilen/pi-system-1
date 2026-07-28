// Test isolation, enforced rather than agreed.
//
// A test that writes gets a database handle that physically cannot write to
// anyone but the test user. Not a naming convention, not a review habit: an
// insert without the test user's id in the payload, or an update or delete
// without it in the filter, throws before it reaches the network.
//
// This exists because scoping lookups by hand failed. A suite written when the
// notebook was empty searched by kind, matched the owner's rows once real ones
// existed, and edited and deleted them. Every future test would have had to
// remember; this one does not depend on remembering.

const { spawn } = require('child_process');

// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

// The person's real id. Named so the guard can say plainly what it stopped.
const REAL_USER_ID = '00000000-0000-0000-0000-000000000001';

// Throwaway. Nothing outside the suites ever reads it.
const TEST_USER_ID = '00000000-0000-0000-0000-00000000fee1';

if (TEST_USER_ID === REAL_USER_ID) {
  throw new Error('the test user must not be the real one');
}

const raw = require(ROOT + '/db.js');

const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

class TestUserViolation extends Error {}

function refuse(detail) {
  throw new TestUserViolation(
    `BLOCKED: a write-capable test tried to touch rows outside the test user.\n` +
      `  ${detail}\n` +
      `  test user: ${TEST_USER_ID}\n` +
      `  Every insert must carry that user_id, and every update or delete must\n` +
      `  filter on it. This is the guard, not a warning: nothing was written.`
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
    if (row.user_id !== TEST_USER_ID) {
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
        if (state.write && !state.payloadChecked && state.user !== TEST_USER_ID) {
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
const db = {
  from(table) {
    return wrap(raw.from(table), { table, user: undefined, write: null, payloadChecked: false });
  },
};

/**
 * A server bound to the test user.
 *
 * The endpoints take their identity from PI_USER_ID, so a suite driving HTTP
 * cannot reach the owner's rows either.
 */
function spawnServer(port, extraEnv = {}) {
  return spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PI_USER_ID: TEST_USER_ID,
      SCHEDULER_DISABLED: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitFor(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(base + '/entries');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

// The test user needs a profile for anything that reads a timezone.
async function ensureProfile(timezone = 'America/New_York', wake = '08:00:00') {
  const { data } = await raw.from('profile').select('user_id').eq('user_id', TEST_USER_ID).maybeSingle();
  if (data) return;
  await db.from('profile').insert({
    user_id: TEST_USER_ID,
    timezone,
    default_wake_time: wake,
    telegram_chat_id: null,
  });
}

/**
 * Remove everything belonging to the test user, and nothing else.
 *
 * Filtered on the test id in every statement, so even the teardown cannot
 * reach past its own rows.
 */
async function cleanup() {
  // plans first: blocks cascade from them.
  for (const table of ['blocks', 'plans', 'entries', 'sent_log', 'messages', 'api_usage', 'profile']) {
    const { error } = await db.from(table).delete().eq('user_id', TEST_USER_ID);
    if (error && !/does not exist/i.test(error.message)) {
      console.error(`[harness] could not clear ${table}: ${error.message}`);
    }
  }
}

// Proves the guard is live. Called at the top of every write-capable suite, so
// a suite that somehow imported the unguarded client fails immediately rather
// than at the moment it does damage.
async function assertGuarded() {
  const attempts = [
    ['insert for the real user', () => db.from('entries').insert({ user_id: REAL_USER_ID, type: 'task', title: 'x' })],
    ['insert with no user at all', () => db.from('entries').insert({ type: 'task', title: 'x' })],
    ['update filtered only by id', () => db.from('entries').update({ title: 'x' }).eq('id', 'some-id')],
    ['delete filtered only by id', () => db.from('entries').delete().eq('id', 'some-id')],
    ['update aimed at the real user', () => db.from('entries').update({ title: 'x' }).eq('user_id', REAL_USER_ID)],
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
  TEST_USER_ID,
  REAL_USER_ID,
  db,
  raw,
  spawnServer,
  waitFor,
  ensureProfile,
  cleanup,
  assertGuarded,
  TestUserViolation,
};
