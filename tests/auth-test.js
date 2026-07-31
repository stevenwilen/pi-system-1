// Who gets in, and who does not.
//
// The isolation suite proves one account cannot reach another's rows. This one
// is a step earlier: what happens to a request that has not established it is
// anybody at all.
//
// The distinction that runs through it: a refusal must be a 401, never an empty
// answer. "You are not signed in" and "you have nothing planned" are different
// facts, and a page that cannot tell them apart shows a blank day to someone
// whose session merely expired.

const H = require('./harness');
const ROOT = H.ROOT;
process.chdir(ROOT);

const PORT = 3598;
const BASE = `http://127.0.0.1:${PORT}`;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Every route the app calls, with a body where one is needed. All of them, not
// a sample: a gate that covers five of six is a gate with a door in it.
const ROUTES = [
  ['GET', '/entries', null],
  ['GET', '/plan/2026-03-04', null],
  ['GET', '/calendar/2026-03-04', null],
  ['POST', '/entries', { type: 'task', title: 'x' }],
  ['POST', '/entries/00000000-0000-0000-0000-0000000000aa/update', { title: 'x' }],
  ['POST', '/entries/00000000-0000-0000-0000-0000000000aa/done', null],
  ['POST', '/entries/00000000-0000-0000-0000-0000000000aa/delete', null],
  ['POST', '/plan', { date: '2026-03-04', wake_minutes: 480, blocks: [] }],
];

function call(method, path, body, headers = {}) {
  return fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

(async () => {
  const { a: A } = await H.setup();

  const server = H.spawnServer(PORT);
  const up = await H.waitFor(BASE);
  if (!up) {
    console.error('server never came up');
    server.kill();
    process.exit(1);
  }

  try {
    console.log('1. no token at all');
    {
      for (const [method, path, body] of ROUTES) {
        const res = await call(method, path, body);
        check(`${method} ${path} is refused`, res.status === 401, String(res.status));
      }
    }

    console.log('\n2. a token that is not a token');
    {
      const nonsense = [
        ['empty', ''],
        ['not a JWT at all', 'hello'],
        ['the right shape, wrong contents', 'aaa.bbb.ccc'],
        // Valid base64url segments and a plausible payload, expired a year ago.
        // What it does not have is the project's signature, which is not this
        // suite's to make — so what this proves is the class, not the clause:
        // anything Supabase will not vouch for is refused. Genuine clock expiry
        // is covered in 4, by revoking a token that was really issued.
        ['expired and unsigned',
          `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.` +
          `${Buffer.from(JSON.stringify({ sub: A.id, role: 'authenticated', exp: 1735689600 })).toString('base64url')}.` +
          'not-a-real-signature'],
      ];

      for (const [what, token] of nonsense) {
        const res = await call('GET', '/entries', null, { Authorization: `Bearer ${token}` });
        check(`${what} is refused`, res.status === 401, String(res.status));
      }

      // Malformed headers, as opposed to malformed tokens.
      for (const [what, header] of [
        ['a bare token with no scheme', A.token],
        ['the wrong scheme', `Basic ${A.token}`],
        ['Bearer with nothing after it', 'Bearer'],
      ]) {
        const res = await call('GET', '/entries', null, { Authorization: header });
        check(`${what} is refused`, res.status === 401, String(res.status));
      }
    }

    console.log('\n3. the project\'s own anon key is not a person');
    {
      // A genuinely signed JWT for this project — the key the browser holds,
      // and the one thing an attacker certainly has, since it is served to
      // anyone who asks. It carries no `sub`, so it stands for nobody, and the
      // server must not accept it as somebody.
      const res = await call('GET', '/entries', null, {
        Authorization: `Bearer ${H.anonKey}`,
      });
      check('a validly signed non-user token is refused', res.status === 401, String(res.status));
    }

    console.log('\n4. a token that was real, for an account that is gone');
    {
      // Issued by Supabase, signed by the project, held while it was good, and
      // then revoked out from under itself by deleting the account. This is the
      // closest the suite can get to expiry without waiting an hour or holding
      // the project's signing secret — and it is the stronger half of the
      // question anyway: the token is genuine, and it is still refused.
      const dead = await H.deadToken();

      const res = await call('GET', '/entries', null, {
        Authorization: `Bearer ${dead.token}`,
      });
      check('a token for a deleted account is refused', res.status === 401, String(res.status));

      // And the refusal is a refusal, not an empty day.
      const body = await res.json().catch(() => ({}));
      check('with an error rather than an empty list', Boolean(body.error) && !('items' in body),
        JSON.stringify(body).slice(0, 80));
    }

    console.log('\n5. a real token still works, or none of the above means anything');
    {
      // THE CONTROL. Every check so far asserts a 401, and a server that had
      // fallen over would return errors to everybody and pass all of them.
      await H.ensureProfile();

      const res = await fetch(`${BASE}/entries`, { headers: A.headers });
      const body = await res.json();
      check('A gets in', res.status === 200, String(res.status));
      check('and is served a list', Array.isArray(body.items), JSON.stringify(Object.keys(body)));
    }

    console.log('\n6. the way in is served to anyone; nothing else is');
    {
      const config = await fetch(`${BASE}/config`);
      const body = await config.json();
      check('/config answers without a token', config.status === 200, String(config.status));
      check('with the project URL', typeof body.url === 'string' && body.url.startsWith('http'),
        String(body.url));
      check('and the anon key', typeof body.anon_key === 'string' && body.anon_key.length > 20);
      check('and NOT the service key', body.anon_key === H.anonKey && !/service/i.test(JSON.stringify(body)),
        'the service key must never leave the server');

      // /version is how a deploy is checked. It says nothing about anybody and
      // must not need credentials.
      const version = await fetch(`${BASE}/version`);
      check('/version answers without a token', version.status === 200, String(version.status));
      const v = await version.json();
      check('and names no user', !JSON.stringify(v).includes(A.id), JSON.stringify(v));
    }
  } finally {
    server.kill();
    await H.cleanup();
  }

  console.log(bad === 0 ? '\nThe gate holds' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e.message, '\n', (e.stack || '').split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
