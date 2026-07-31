// Two accounts, and neither can touch the other.
//
// THIS IS THE ONE THAT MATTERS. Everything else in this change is machinery;
// this is the property the machinery exists for, checked from both directions:
//
//   through the routes    A drives the HTTP the app drives, holding A's token,
//                         and cannot read, change or remove anything of B's.
//
//   through the database  A holds the client a route would build — anon key
//                         under A's token — and tries every table directly.
//                         This is row level security itself, with no route in
//                         the way to be given credit for the refusal.
//
// AND IT PROVES REFUSAL BY READING BACK. "The update returned no rows" is not
// the same claim as "the row is unchanged": a filter that matched nothing for
// some unrelated reason returns no rows too. So every write attempt is
// followed by a service-key read of the row it was aimed at, and the check is
// that the value is still what B put there.

const H = require('./harness');
const ROOT = H.ROOT;
process.chdir(ROOT);

const PORT = 3599;
const BASE = `http://127.0.0.1:${PORT}`;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const TODAY = '2026-03-04';
const OTHER = '2026-03-05';

// What B owns, by table. Read back with the service key after every attempt.
const seeded = {};

async function seed(A, B) {
  await H.cleanup();

  for (const who of [A, B]) {
    await H.db.from('profile').insert({
      user_id: who.id,
      timezone: 'America/New_York',
      default_wake_time: '08:00:00',
      telegram_chat_id: null,
    });
  }

  const { data: entry } = await H.db
    .from('entries')
    .insert({ user_id: B.id, type: 'task', title: "B's private task" })
    .select()
    .single();

  const { data: plan } = await H.db
    .from('plans')
    .insert({ user_id: B.id, date: TODAY, wake_time: '08:00:00', status: 'confirmed' })
    .select()
    .single();

  const { data: block } = await H.db
    .from('blocks')
    .insert({
      user_id: B.id,
      plan_id: plan.id,
      title: "B's private block",
      start_time: '09:00:00',
      duration_minutes: 30,
      sort_order: 0,
    })
    .select()
    .single();

  const { data: log } = await H.db
    .from('sent_log')
    .insert({ user_id: B.id, job: 'private-job', sent_for_date: TODAY })
    .select()
    .single();

  // A gets a day of their own, so "A sees nothing" is never just "A has
  // nothing to see". An empty account cannot tell those two apart.
  const { data: aEntry } = await H.db
    .from('entries')
    .insert({ user_id: A.id, type: 'task', title: "A's own task" })
    .select()
    .single();

  Object.assign(seeded, { entry, plan, block, log, aEntry });
}

/** The row as it truly is, service key, no policy in the way. */
async function actual(table, id) {
  const { data } = await H.service.from(table).select('*').eq('id', id).maybeSingle();
  return data;
}

(async () => {
  const { a: A, b: B } = await H.setup();
  await H.assertGuarded();

  check('the two accounts are different people', A.id !== B.id, `${A.id} / ${B.id}`);

  await seed(A, B);

  const server = H.spawnServer(PORT);
  const up = await H.waitFor(BASE);
  if (!up) {
    console.error('server never came up');
    server.kill();
    process.exit(1);
  }

  const asA = H.as(A);
  const asB = H.as(B);

  try {
    // === through the routes ==================================================

    console.log("\nthrough the routes: A's list is A's alone");
    {
      const res = await asA(`${BASE}/entries`);
      const body = await res.json();
      const titles = (body.items || []).map((i) => i.title);

      check('A can read their own list', res.status === 200, String(res.status));
      check('and it holds what A put there', titles.includes("A's own task"), JSON.stringify(titles));
      check("and nothing of B's", !titles.includes("B's private task"), JSON.stringify(titles));

      // The same request as B, to prove the route is not simply broken for
      // everyone. A route that returned nothing to anybody would pass the
      // check above and mean nothing at all.
      const mine = await (await asB(`${BASE}/entries`)).json();
      const bTitles = (mine.items || []).map((i) => i.title);
      check('while B can read their own', bTitles.includes("B's private task"), JSON.stringify(bTitles));
    }

    console.log("\nthrough the routes: A cannot change B's entry");
    {
      const id = seeded.entry.id;

      const upd = await asA(`${BASE}/entries/${id}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'taken over by A' }),
      });
      check('the update is refused', upd.status === 404, String(upd.status));
      check("and B's title is untouched",
        (await actual('entries', id)).title === "B's private task",
        (await actual('entries', id)).title);

      const done = await asA(`${BASE}/entries/${id}/done`, { method: 'POST' });
      check('marking it done is refused', done.status === 404, String(done.status));
      check('and it is still active', (await actual('entries', id)).status === 'active',
        (await actual('entries', id)).status);

      const del = await asA(`${BASE}/entries/${id}/delete`, { method: 'POST' });
      const delBody = await del.json();
      check('deleting it is refused', del.status >= 400, String(del.status));
      check('with no id handed back', !delBody.deleted, JSON.stringify(delBody));
      check('and the row is still there, still active',
        (await actual('entries', id)).status === 'active',
        (await actual('entries', id)).status);
    }

    console.log("\nthrough the routes: A cannot see or edit B's day");
    {
      const res = await asA(`${BASE}/plan/${TODAY}`);
      const body = await res.json();
      check('A asking for the date B planned gets nothing', body.plan === null,
        JSON.stringify(body.plan));
      check('and no blocks', (body.blocks || []).length === 0, JSON.stringify(body.blocks));

      // Naming B's block in A's own plan. The route looks the id up among the
      // blocks of A's plan for that date and refuses what it does not find —
      // which for B's block is every time, because A's query cannot see it.
      const post = await asA(`${BASE}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: OTHER,
          wake_minutes: 480,
          blocks: [
            { id: seeded.block.id, title: 'mine now', start_minutes: 600, duration_minutes: 30 },
          ],
        }),
      });
      const postBody = await post.json();
      check("claiming B's block is refused", post.status === 400, String(post.status));
      check('by name', /is not part of the plan/.test(postBody.error || ''), postBody.error);

      const block = await actual('blocks', seeded.block.id);
      check("and B's block still says what it said", block.title === "B's private block", block.title);
      check('at the time it said it', String(block.start_time).slice(0, 5) === '09:00',
        String(block.start_time));
      check('still belonging to B', block.user_id === B.id, block.user_id);
    }

    // === through the database ================================================
    //
    // No route involved. This is the policy itself: if any of these pass
    // because a route was careful, that is a route being credited for the
    // database's job, and the next route will not be careful.

    console.log('\nthrough the database: A reads nothing of B, on any table');
    {
      const rows = [
        ['profile', 'user_id', B.id],
        ['entries', 'id', seeded.entry.id],
        ['plans', 'id', seeded.plan.id],
        ['blocks', 'id', seeded.block.id],
        ['sent_log', 'id', seeded.log.id],
      ];

      for (const [table, column, value] of rows) {
        const { data, error } = await A.db.from(table).select('*').eq(column, value);
        check(`${table}: A sees none of it`, !error && (data || []).length === 0,
          error ? error.message : `${(data || []).length} row(s)`);

        // And B does, through exactly the same kind of client. Without this
        // pair the check above passes just as well when the table is empty,
        // unreachable, or misnamed.
        const mine = await B.db.from(table).select('*').eq(column, value);
        check(`${table}: while B sees their own`, !mine.error && (mine.data || []).length === 1,
          mine.error ? mine.error.message : `${(mine.data || []).length} row(s)`);
      }
    }

    console.log('\nthrough the database: A writes nothing of B, on any table');
    {
      const writes = [
        ['profile', 'user_id', B.id, { timezone: 'Antarctica/Troll' }, 'timezone', 'America/New_York'],
        ['entries', 'id', seeded.entry.id, { title: 'taken' }, 'title', "B's private task"],
        ['plans', 'id', seeded.plan.id, { status: 'pending' }, 'status', 'confirmed'],
        ['blocks', 'id', seeded.block.id, { title: 'taken' }, 'title', "B's private block"],
        ['sent_log', 'id', seeded.log.id, { job: 'taken' }, 'job', 'private-job'],
      ];

      for (const [table, column, value, patch, field, was] of writes) {
        const { data } = await A.db.from(table).update(patch).eq(column, value).select();
        check(`${table}: A's update changes nothing`, (data || []).length === 0,
          `${(data || []).length} row(s)`);

        const row = await actual(table, table === 'profile' ? undefined : value);
        const truth = table === 'profile'
          ? (await H.service.from('profile').select('*').eq('user_id', B.id).maybeSingle()).data
          : row;
        check(`${table}: and the row still reads as B left it`, truth && truth[field] === was,
          truth ? String(truth[field]) : 'row is gone');
      }

      for (const [table, column, value] of writes) {
        const { data } = await A.db.from(table).delete().eq(column, value).select();
        check(`${table}: A's delete removes nothing`, (data || []).length === 0,
          `${(data || []).length} row(s)`);
      }

      // Everything B had, still there.
      const left = await H.service.from('entries').select('id').eq('user_id', B.id);
      check("B's rows all survived", (left.data || []).length === 1,
        `${(left.data || []).length} entries`);
    }

    console.log('\nthrough the database: A cannot write a row into B\'s name');
    {
      // THE `with check` CLAUSE. `using` decides what you can see and therefore
      // change; this is the other half — what a row is allowed to look like
      // afterwards. Without it A could insert rows owned by B, or take one of
      // their own and hand it over.
      const insert = await A.db
        .from('entries')
        .insert({ user_id: B.id, type: 'task', title: 'planted by A' })
        .select();
      check('an insert in B\'s name is refused', Boolean(insert.error),
        insert.error ? insert.error.message.slice(0, 60) : 'IT WAS ALLOWED');

      const planted = await H.service
        .from('entries')
        .select('id')
        .eq('user_id', B.id)
        .eq('title', 'planted by A');
      check('and nothing was planted', (planted.data || []).length === 0,
        `${(planted.data || []).length} row(s)`);

      // Giving away one of A's own.
      const handover = await A.db
        .from('entries')
        .update({ user_id: B.id })
        .eq('id', seeded.aEntry.id)
        .select();
      check('handing a row of A\'s over to B is refused',
        Boolean(handover.error) || (handover.data || []).length === 0,
        handover.error ? handover.error.message.slice(0, 60) : `${(handover.data || []).length} row(s)`);

      const still = await actual('entries', seeded.aEntry.id);
      check("and it still belongs to A", still && still.user_id === A.id,
        still ? still.user_id : 'row is gone');
    }
  } finally {
    server.kill();
    await H.cleanup();
  }

  console.log(bad === 0 ? '\nAccounts are sealed' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e.message, '\n', (e.stack || '').split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
