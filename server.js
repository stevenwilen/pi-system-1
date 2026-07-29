// The web server. Serves the page, mounts the routes, and starts delivery.
//
// Nothing is handled here. Every route lives in routes/, one file per section
// of the screen. None of them calls the model, and neither does anything they
// reach: every value on the screen is a database read or arithmetic on one.

require('dotenv').config();

const path = require('path');
const express = require('express');

// Requiring the scheduler starts its cron loop as a side effect, which is how
// delivery runs in this one process. Nothing is imported from it.
require('./scheduler');

// Railway (and most hosts) assign the port at runtime and route only to it.
// Falls back to 3000 when running locally.
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // not just localhost, so the phone can reach it

const app = express();

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

app.use(require('./routes/entries'));
app.use(require('./routes/plan'));
app.use(require('./routes/review'));

// Several tables are no longer read or written: `messages`, and everything the
// finance lane used. They are deliberately left in place with their rows.
// Dropping a table is the one move that cannot be undone, and an unread table
// costs nothing.

// --- which build is this ----------------------------------------------------

const STARTED_AT = new Date().toISOString();

/**
 * What is actually running.
 *
 * "Has it deployed yet" has cost several rounds of guessing, answered only by
 * probing for a route that happens to be new and inferring from a 404. The
 * host sets the commit it built, so this reports it directly.
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

app.listen(PORT, HOST, () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log(`on your phone, use http://<this-machine's-lan-ip>:${PORT}`);
});
