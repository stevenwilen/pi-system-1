// Supabase clients. The only place credentials are read.
//
// TWO clients, and which one a piece of code holds is the whole security model:
//
//   forUser(token)  the caller's own connection. Built from the ANON key with
//                   the caller's access token, so PostgREST runs it as the
//                   `authenticated` role and row level security applies. This
//                   is what every route uses.
//
//   service         bypasses row level security entirely. Only the scheduler
//                   and the command line tools may hold it, because they act
//                   across all users and have no caller to be.
//
// THE ANON KEY, NOT THE SERVICE KEY, under the caller's token. Both would work
// on the happy path — PostgREST takes the role from the Authorization JWT, so a
// user's token yields `authenticated` either way. They differ entirely in how
// they FAIL. With no token, or an empty one, an anon-key client falls back to
// the `anon` role, which no policy grants anything to. A service-key client
// falls back to `service_role`, which is every row in the database. The happy
// path is not the part worth designing.

require('dotenv').config();

const { AsyncLocalStorage } = require('node:async_hooks');
const { createClient } = require('@supabase/supabase-js');

const rawUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!rawUrl || !serviceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
}

// .env may hold either a full URL or just the project ref.
const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}.supabase.co`;

const OFFLINE = { persistSession: false, autoRefreshToken: false };

/**
 * The scope one HTTP request runs inside.
 *
 * server.js opens this around every request. Nothing reads what is in it; its
 * presence is the whole signal, and it answers exactly one question: is this
 * code running on behalf of a caller right now?
 */
const requestScope = new AsyncLocalStorage();

/**
 * The service client, wrapped so it cannot be used inside a request.
 *
 * The static check in tests/service-key-check.js reads the import graph and
 * refuses a route that can reach this. That check is the one that fails early
 * and names the file, and it is where a mistake should normally be caught.
 *
 * This is the layer under it, for what reading imports cannot see: a require
 * computed at runtime, a helper that grew a second caller, a module that a
 * route reaches by a path the walker does not model. Reading imports is a
 * claim about the code; this is a fact about the process.
 */
function guardService(client) {
  const refuse = (what) => {
    throw new Error(
      `The service key was used inside a request (${what}).\n` +
        `  It bypasses row level security, so a route holding it serves every\n` +
        `  user's rows to whoever asked. Routes take their client from\n` +
        `  req.auth.db, which carries the caller's own token.\n` +
        `  Only scheduler.js and the command line tools may hold this one.`
    );
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from' || prop === 'rpc') {
        return (...args) => {
          if (requestScope.getStore()) refuse(`${String(prop)}('${args[0]}')`);
          return target[prop](...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const service = guardService(createClient(url, serviceKey, { auth: OFFLINE }));

/**
 * A client that is the caller and nothing more.
 *
 * The token is passed as a header rather than through signIn, because there is
 * no session to hold: the request carries its own proof and the client lives
 * for one request. Persisting anything here would mean one caller's identity
 * outliving their request in a process that serves everyone.
 */
function forUser(accessToken) {
  if (!anonKey) {
    throw new Error(
      'Missing SUPABASE_ANON_KEY in .env. Every route builds its database\n' +
        '  client from the caller\'s token and this key; without it there is no\n' +
        '  way to serve a request except with the service key, which would\n' +
        '  bypass row level security.'
    );
  }
  if (!accessToken) throw new Error('forUser called with no access token');

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: OFFLINE,
  });
}

module.exports = { forUser, service, requestScope, url, anonKey };
