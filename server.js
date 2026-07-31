// The web server. Serves the page, mounts the routes, and starts delivery.
//
// Nothing is handled here. Every route lives in routes/, one file per section
// of the screen. None of them calls the model, and neither does anything they
// reach: every value on the screen is a database read or arithmetic on one.

require('dotenv').config();

const path = require('path');
const express = require('express');

const { forUser, requestScope, url: SUPABASE_URL, anonKey } = require('./db');
const { userFrom, bearer } = require('./user');

// Loud, at boot, rather than as a failed request later. Without this key no
// route can build a client that is the caller, and the only client left is the
// one that bypasses row level security.
//
// BEFORE the scheduler, because requiring that starts cron. Checked after it,
// this still refused to start — but it had already begun a delivery loop on the
// way to saying so, and a process that fires a tick and then aborts is a worse
// failure than the one being reported.
if (!anonKey) {
  throw new Error(
    'Missing SUPABASE_ANON_KEY in .env. Routes cannot serve anyone without it,\n' +
      '  and the server will not start pretending otherwise.'
  );
}

// Requiring the scheduler starts its cron loop as a side effect, which is how
// delivery runs in this one process. Nothing is imported from it.
require('./scheduler');

// Railway (and most hosts) assign the port at runtime and route only to it.
// Falls back to 3000 when running locally.
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // not just localhost, so the phone can reach it

const app = express();

// EVERY request runs inside the scope, static files included. Its presence is
// what makes the service client throw, and the point of putting it first is
// that there is no request-handling code anywhere in this process that runs
// outside it — which is the only way that guard means anything.
app.use((req, res, next) => requestScope.run({ path: req.path }, next));

app.use(express.json());
// The page is revalidated on every load, the assets are not.
//
// index.html is the whole app: markup, styles and script in one file. Letting
// a browser reuse it without asking means a fixed bug keeps rendering, which
// has already happened twice. `no-cache` is not "do not store", it is "ask
// first", so an unchanged page still costs one 304 rather than a download.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// --- who is asking -----------------------------------------------------------

/**
 * What the browser needs to sign someone in.
 *
 * Served rather than written into index.html so that rotating the key is a
 * dashboard action and a restart, not an edit to the app. The anon key is
 * public by design — it identifies the project, it does not authorise anything
 * on its own, and every row it can reach is reached through a policy.
 *
 * Before the gate, necessarily: this is what you fetch when you have nothing.
 */
app.get('/config', (req, res) => {
  res.json({ url: SUPABASE_URL, anon_key: anonKey });
});

// --- which build is this ----------------------------------------------------

const STARTED_AT = new Date().toISOString();

/**
 * What is actually running.
 *
 * "Has it deployed yet" has cost several rounds of guessing, answered only by
 * probing for a route that happens to be new and inferring from a 404. The
 * host sets the commit it built, so this reports it directly.
 *
 * Ahead of the gate, and it moved here to stay that way. It used to sit at the
 * bottom of the file, which put it behind the gate the moment one existed —
 * and the check that tells you whether a deploy landed is the last thing that
 * should need credentials. It says nothing about anybody.
 */
app.get('/version', (req, res) => {
  res.json({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    deployed: process.env.RAILWAY_DEPLOYMENT_ID || null,
    started_at: STARTED_AT,
    node: process.version,
    // Named so a stale build is obvious without knowing any commit hash.
    lanes: ['planner'],
    scheduler: process.env.SCHEDULER_DISABLED === '1' ? 'DISABLED' : 'running',
  });
});

/**
 * The gate. Past here, req.auth exists and is somebody.
 *
 * There is no anonymous path through this and no default user to fall back to.
 * A request either carries a token that Supabase verifies, or it is refused —
 * those are the only two outcomes, and the second one is a 401 rather than an
 * empty result, because "you are not signed in" and "you have nothing" must
 * never look the same on screen.
 *
 * The client it hands on carries the caller's own token, so every query it
 * makes is subject to row level security. The routes still filter on user_id
 * as well. That is deliberate duplication: the filter is what the code means,
 * the policy is what the database enforces, and neither is a good enough
 * reason to drop the other.
 */
app.use(async (req, res, next) => {
  const token = bearer(req.headers.authorization);
  if (!token) return res.status(401).json({ error: 'not signed in' });

  let user;
  try {
    user = await userFrom(token);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (!user) return res.status(401).json({ error: 'not signed in' });

  req.auth = { userId: user.id, email: user.email, db: forUser(token) };
  next();
});

app.use(require('./routes/entries'));
app.use(require('./routes/plan'));
app.use(require('./routes/settings'));

// Several tables are no longer read or written: `messages`, and everything the
// finance lane used. They are deliberately left in place with their rows.
// Dropping a table is the one move that cannot be undone, and an unread table
// costs nothing.

app.listen(PORT, HOST, () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log(`on your phone, use http://<this-machine's-lan-ip>:${PORT}`);
});
