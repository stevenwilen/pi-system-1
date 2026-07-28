# Tests

```
npm test                     # everything, in order
node tests/run-all.js due-test.js nudge-test.js   # named suites only
```

They run against the **real Supabase project**, not a fixture database, so
`.env` has to be present. Some suites need more than that and say so rather
than failing obscurely: `money-test.js` skips its endpoint half without
`FINANCE_TRANSACTIONS_CSV_URL`, and `due-test.js` exits early if its migration
has not been run.

Five of them make real Anthropic calls. Those are the slow ones and they cost
money: `messages-test`, `order-cold-test`, `no-repeat-test`, `insight-test`,
`injection-test`. Nothing sends a real Telegram message — every suite that
touches delivery stubs the sender before loading the scheduler.

## The guard

Everything that writes goes through `harness.js`, which hands back a database
handle that **cannot** write to anyone but the test user. An insert without the
test id in the payload, or an update or delete without it in the filter, throws
before it reaches the network.

This exists because scoping by hand failed. A suite written when the notebook
was empty looked its rows up by kind, matched the owner's real rows once there
were some, and overwrote one that could not be recovered.

`run-all.js` refuses to start a suite that could reach real rows at all. It
reads each file before spawning anything and rejects it if it names the real
user id, or loads a module that can reach `db.js` without importing the harness,
or starts a server without pointing it at the test user. Whether a module can
reach the database is **resolved** by following its imports, not guessed from a
list, so the check stays right when the code moves.

That guard is not decoration. It has caught three real holes: a suite writing
two rows to the owner's list on every run, and two more starting a real server
as the real person.

## Writing another one

Start from the top of any existing suite. The shape is:

```js
const H = require('./harness');
const U = H.TEST_USER_ID;

await H.assertGuarded();   // proves the guard is live before writing anything
await H.ensureProfile();
...
await H.cleanup();         // removes every row this user owns
```

Two rules worth keeping:

- **Never name the real user id.** The runner will refuse the file.
- **Assert against non-empty data.** A check that passes against zero rows has
  verified nothing, and several here have been caught doing exactly that.
