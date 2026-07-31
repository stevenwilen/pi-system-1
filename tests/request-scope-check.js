// The runtime half of the service-key guard.
//
// tests/service-key-check.js reads the import graph and refuses a route that
// can reach the service client. This proves the thing underneath it: that even
// if something did reach it, the call would throw rather than succeed.
//
// The two are not redundant. Reading imports is a claim about the shape of the
// code, and there are ways past it — a require built at runtime, a helper that
// grows a second caller, a module reached by a path the walker does not model.
// This one does not care how the call got there.
//
// No network: nothing here awaits a query, only starts one.

// Through the harness rather than straight to db.js. The suite runner refuses
// anything that can reach the database without it, and that rule is right even
// here: this file never awaits a query, but "it only builds them" is exactly
// the kind of promise the rule exists not to have to take on trust.
const H = require('./harness');
const ROOT = H.ROOT;

const { service, forUser, requestScope } = H;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

/** What happened when this ran: an Error, or null. */
function attempt(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

console.log('1. outside a request the service client works as it always did');
{
  const err = attempt(() => service.from('entries'));
  check('a query can be built', err === null, err && err.message);

  // The scheduler is the caller this is for, and it runs on a timer. Timers
  // fire outside any request scope, which is the whole reason this works.
  requestScope.run({ path: '/plan' }, () => {});
  const after = attempt(() => service.from('entries'));
  check('and still works after a request has come and gone', after === null, after && after.message);
}

console.log('\n2. inside a request it refuses');
{
  let err = null;
  requestScope.run({ path: '/entries' }, () => {
    err = attempt(() => service.from('entries'));
  });

  check('the call throws', err !== null);
  check('and says what was wrong', /service key was used inside a request/i.test((err || {}).message),
    (err || {}).message);
  check('naming the table it was aimed at', /entries/.test((err || {}).message));

  // rpc as well as from. Both reach data; guarding one would leave the other
  // as the way round it.
  let rpcErr = null;
  requestScope.run({ path: '/entries' }, () => {
    rpcErr = attempt(() => service.rpc('anything'));
  });
  check('rpc is guarded too', rpcErr !== null, 'from() alone would leave a way round');
}

console.log('\n3. the guard survives the await a real request is full of');
{
  // THE CASE THIS IS ACTUALLY FOR. A route awaits several times before it gets
  // to a query. AsyncLocalStorage is what carries the scope across those
  // awaits; a plain module-level flag set and cleared around the handler would
  // be wrong the moment two requests overlapped, which is every request.
  const ran = [];

  const work = (label) =>
    requestScope.run({ path: label }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 5));
      ran.push([label, attempt(() => service.from('entries')) !== null]);
    });

  (async () => {
    await Promise.all([work('/a'), work('/b'), work('/c')]);

    check('every one of three overlapping requests was refused',
      ran.length === 3 && ran.every(([, blocked]) => blocked),
      JSON.stringify(ran));

    // And the scheduler, running its tick while those requests are in flight,
    // is not caught by them.
    const scheduler = attempt(() => service.from('blocks'));
    check('while work outside a request is not', scheduler === null, scheduler && scheduler.message);

    console.log('\n4. the caller-scoped client is never the service one');
    {
      // forUser needs the anon key. Without it the factory throws, and that is
      // the correct behaviour — but it means this check can only run where the
      // key is configured, so it says which case it is in rather than passing
      // quietly either way.
      let client = null;
      const err = attempt(() => {
        client = forUser('a-token-shaped-string');
      });

      if (err && /SUPABASE_ANON_KEY/.test(err.message)) {
        check('SKIPPED: no SUPABASE_ANON_KEY, so forUser cannot be built', false,
          'this is a configuration gap, not a passing test');
      } else {
        check('forUser built a client', client !== null, err && err.message);
        let inside = null;
        requestScope.run({ path: '/entries' }, () => {
          inside = attempt(() => client.from('entries'));
        });
        check('and it is usable inside a request, unlike the service one',
          inside === null, inside && inside.message);
      }
    }

    console.log(bad === 0 ? '\nRequest scope holds' : `\n${bad} FAILURE(S)`);
    process.exit(bad === 0 ? 0 : 1);
  })();
}
