// Finishing something, and what a block that stayed in the day is worth.
//
// Two holes that were the same hole: the system recorded outcomes and then
// never read them. A completed task stayed on the list forever, and a block
// that never happened reset the staleness clock exactly as much as one that
// did — so something dodged four weeks running read as fresh every Monday.
//
// How you say it did not happen has changed. There was a mark for it once;
// now you take the block out of the day, and staleness reads the blocks that
// are left. The `completed` filter in staleness.js survives that change and is
// still pinned below, because the column is still there and still defaults to
// true — but nothing in the app sets it any more, so these rows write it
// directly.
//
// All of it is checked against real rows, because the claim is about what the
// database returns and not about what the code looks like.
const H = require('./harness');
// The test account, discovered rather than written down. It is a real auth
// user now, created by the harness, so its id is not knowable until it
// exists — which is why this is assigned inside the run rather than at the
// top of the file.
let U;

// Every request this suite makes, as the test account.
//
// The server takes its user from the token and refuses a request without
// one, so a bare fetch here would not read as a broken test — it would read
// as an account with nothing in it.
let authed = () => {
  throw new Error('the account is not signed in yet');
};
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const { lastScheduled } = require(ROOT + '/staleness.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Its own port. 3986 belongs to calendar-endpoint-test.
const PORT = 3988;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

const post = async (p, body) => {
  const r = await authed(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => (await authed(BASE + p)).json();

// Rows this suite made, cleaned up whatever happens.
const made = { entries: [], plans: [] };

async function entry(type, title) {
  const { data, error } = await H.db
    .from('entries')
    .insert({ user_id: U, type, title })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  made.entries.push(data.id);
  return data.id;
}

// A plan on a date, holding a block per entry, each done or missed.
//
// One plan per date: plans are unique on (user_id, date), so two entries being
// compared on the same day have to share a plan, which is what a real day does
// anyway.
async function planWith(date, blocks) {
  const { data: plan, error } = await H.db
    .from('plans')
    .insert({ user_id: U, date, wake_time: '08:00:00', status: 'confirmed' })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  made.plans.push(plan.id);

  const { error: blockErr } = await H.db.from('blocks').insert(
    blocks.map(([entryId, completed], i) => ({
      user_id: U,
      plan_id: plan.id,
      entry_id: entryId,
      title: 'whatever',
      start_time: `${String(9 + i).padStart(2, '0')}:00:00`,
      duration_minutes: 30,
      completed,
    }))
  );
  if (blockErr) throw new Error(blockErr.message);
  return plan.id;
}

// Every delete filters on the test user, which the harness guard enforces
// rather than trusts.
async function cleanup() {
  for (const id of made.plans) {
    await H.db.from('blocks').delete().eq('user_id', U).eq('plan_id', id);
    await H.db.from('plans').delete().eq('user_id', U).eq('id', id);
  }
  for (const id of made.entries) {
    await H.db.from('entries').delete().eq('user_id', U).eq('id', id);
  }
  made.plans.length = 0;
  made.entries.length = 0;
}

(async () => {
  U = await H.userId();
  authed = H.as((await H.setup()).a);
  await H.assertGuarded();
  // Everything the test user owns, before the profile is put back. A run that
  // died holding rows would otherwise collide here: plans are unique on
  // (user_id, date), so the leftovers are not inert.
  await H.cleanup();
  await H.ensureProfile();

  server = H.spawnServer(PORT);
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  console.log('a block that stayed in the day counts');
  {
    const kept = await entry('habit', 'Gym done');
    await planWith('2031-01-10', [[kept, true]]);

    const seen = await lastScheduled(H.db, U);
    check('it counts', seen.get(kept) === '2031-01-10', String(seen.get(kept)));
  }

  console.log('\nand the completed filter still holds, though nothing sets it');
  {
    // Inert in practice: the app never writes false any more. Pinned anyway,
    // because the column and the filter both survive, and a query that stopped
    // meaning what it says is the kind of thing that is noticed years later.
    const flagged = await entry('habit', 'Gym dodged');
    await planWith('2031-01-11', [[flagged, false]]);

    const seen = await lastScheduled(H.db, U);
    check('a row marked otherwise is excluded', !seen.has(flagged),
      String(seen.get(flagged)));
  }

  console.log('\ntaking a block out of the day is what stops it counting');
  {
    // The mechanism that replaced the mark, end to end through the real route.
    const dodged = await entry('task', 'Passport');
    const DAY = '2031-02-01';

    const planned = await post('/plan', {
      date: DAY, wake_minutes: 480,
      blocks: [{ title: 'Passport', entryId: dodged, start_minutes: 540, duration_minutes: 30 }],
    });
    check('the day saves', planned.status === 200, JSON.stringify(planned.body));
    made.plans.push((await H.db.from('plans').select('id')
      .eq('user_id', U).eq('date', DAY).single()).data.id);

    const withIt = (await get('/entries')).items.find((i) => i.id === dodged);
    check('and it counts while the block is in the day',
      withIt.last_scheduled === DAY, String(withIt.last_scheduled));

    // The day happens, or does not. Confirming without it is the removal.
    const emptied = await post('/plan', {
      date: DAY, wake_minutes: 480,
      blocks: [{ title: 'Something else', start_minutes: 540, duration_minutes: 30 }],
    });
    check('re-confirming without it is accepted', emptied.status === 200,
      JSON.stringify(emptied.body));

    const without = (await get('/entries')).items.find((i) => i.id === dodged);
    check('it stops counting', without.last_scheduled === null,
      String(without.last_scheduled));
    check('and is still on the list, waiting to be planned again', Boolean(without));
  }

  console.log('\na task that is done leaves the list');
  {
    const task = await entry('task', 'Haircut');
    check('it starts on the list', (await get('/entries')).items.some((i) => i.id === task));

    const r = await post(`/entries/${task}/done`);
    check('done is accepted', r.status === 200, JSON.stringify(r.body));

    const after = await get('/entries');
    check('it is off the list', !after.items.some((i) => i.id === task));
    check('and there is no second list for it to hide in', after.paused === undefined);

    // Kept, not destroyed. This is the whole difference from Delete.
    const { data } = await H.db.from('entries').select('status').eq('id', task).single();
    check('the row is still there, marked done', data && data.status === 'done', JSON.stringify(data));
  }

  console.log('\nonly a task can be done in one go');
  {
    const habit = await entry('habit', 'Spanish');
    const project = await entry('project', 'Thesis');

    const h = await post(`/entries/${habit}/done`);
    check('a habit is refused', h.status === 400, JSON.stringify(h.body));
    const p = await post(`/entries/${project}/done`);
    check('a project is refused', p.status === 400, JSON.stringify(p.body));

    const list = await get('/entries');
    check('and both are still on the list',
      list.items.some((i) => i.id === habit) && list.items.some((i) => i.id === project));
  }

  console.log('\ndone is not delete, and a tombstone stays one');
  {
    const gone = await entry('task', 'Deleted thing');
    await post(`/entries/${gone}/delete`);

    const r = await post(`/entries/${gone}/done`);
    check('a deleted row cannot be finished', r.status === 404, JSON.stringify(r.body));

    const { data } = await H.db.from('entries').select('status').eq('id', gone).single();
    check('it is still a tombstone', data && data.status === 'deleted', JSON.stringify(data));

    // The tool the brain holds has to refuse it too, not just the route.
    const { update_entry } = require(ROOT + '/tools.js');
    const viaTool = await update_entry(H.db, U, gone, { status: 'done' });
    check('and the tool refuses it as well', Boolean(viaTool.error), JSON.stringify(viaTool).slice(0, 80));

    const { data: still } = await H.db.from('entries').select('status').eq('id', gone).single();
    check('still a tombstone after that', still && still.status === 'deleted', JSON.stringify(still));
  }

  console.log('\nan untimed item counts for staleness only when it is ticked');
  {
    // THE PART OF "ANYTIME TODAY" THAT MATTERS, and the reason the completed
    // column came back to life.
    //
    // A timed block counts by staying in the day: it had an hour, the hour
    // passed, and taking it out is how you say otherwise. An untimed item has
    // no hour to have passed, so the same rule would count it the moment it
    // was added — reading would report "0 days since" for something nobody
    // did. The opposite mistake is worse and is the one this fixes: without
    // any rule at all, a thing done every day as an untimed item would read
    // "11 days since" for ever, because staleness only ever saw timed blocks.
    const daily = await entry('habit', 'Reading, untimed');
    const DAY = '2031-04-01';

    // CONFIRMED THROUGH THE ROUTE, not inserted behind it. The rule that an
    // untimed item is written not-done lives in the confirm, and a fixture
    // that wrote `completed: false` by hand would be asserting its own setup:
    // the first version of this did exactly that, and setting the column true
    // in the route changed nothing here at all.
    const day = await post('/plan', {
      date: DAY, wake_minutes: 480,
      blocks: [
        { title: 'Reading, untimed', entryId: daily, start_minutes: null, duration_minutes: null },
      ],
    });
    check('the day confirms', day.status === 200, JSON.stringify(day.body));

    const { data: plan } = await H.db
      .from('plans').select('id').eq('user_id', U).eq('date', DAY).single();
    made.plans.push(plan.id);

    const item = { id: day.body.ids[0] };
    check('and the item exists', Boolean(item.id), JSON.stringify(day.body.ids));

    const seen = async () => (await lastScheduled(H.db, U)).get(daily);

    check('an untimed item nobody ticked does not count', (await seen()) === undefined,
      String(await seen()));

    // AND THE CONTROL. The same row, ticked, must count — or the check above
    // passes just as well against a staleness query that is simply broken.
    const marked = await post(`/plan/block/${item.id}/done`, { done: true });
    check('ticking it is accepted', marked.status === 200, JSON.stringify(marked.body));
    check('AND IT COUNTS FROM THAT DAY', (await seen()) === DAY, String(await seen()));

    // Unticked again, it stops counting. The clock keeps running, which is
    // what an item left unmarked at the end of a day means.
    await post(`/plan/block/${item.id}/done`, { done: false });
    check('unticking stops it counting again', (await seen()) === undefined,
      String(await seen()));

    // A TIMED BLOCK IS NOT TICKED OFF. Its completion is not a thing this
    // system tracks — it counts by staying in the day — and a route that could
    // set it false would be a second, quieter answer to the same question,
    // with staleness reading whichever of them wrote last.
    const { data: timed } = await H.db
      .from('blocks')
      .insert({
        user_id: U, plan_id: plan.id, entry_id: daily, title: 'Reading, timed',
        start_time: '09:00:00', duration_minutes: 30, sort_order: 1,
      })
      .select('id')
      .single();

    const refused = await post(`/plan/block/${timed.id}/done`, { done: false });
    check('a block with an hour cannot be ticked off', refused.status === 400,
      JSON.stringify(refused.body));
    check('and it says what to do instead', /take it out of the day/i.test(refused.body.error || ''),
      refused.body.error);

    // It counted all along, by existing.
    check('the timed one counted the whole time', (await seen()) === DAY, String(await seen()));

    const junk = await post(`/plan/block/${item.id}/done`, { done: 'yes' });
    check('done must be true or false', junk.status === 400, JSON.stringify(junk.body));

    await cleanup();
  }

  console.log('\nthe page offers Done where it means something');
  {
    const fs = require('fs');
    const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
    check('only on a task', /item\.type === 'task'/.test(html));
    check('and it posts to the done route', /entries\/\$\{item\.id\}\$\{path\}/.test(html));
    check('which Done names', /takeOff\(item, 'Done', '\/done'\)/.test(html));

    // DELETE ASKS AGAIN, and this time in the page rather than at the browser.
    //
    // It went the other way once: the undo replaced a native confirm, on the
    // grounds that a confirm interrupts every delete to catch the rare wrong
    // one. That argument holds for a block, which is one day and is rewritten
    // on the next confirm. It does not hold for a thing, which may be weeks of
    // history behind it and cannot come back at all — `status = 'deleted'` is
    // a tombstone, as the cases above this one prove twice over. There is no
    // undo to offer, so the doubt is raised before the write instead.
    check('deleting a thing asks first', /`Delete \$\{item\.title\}\?`/.test(html));
    // In the list, so it can name the thing and so the words can be Cancel and
    // Delete rather than OK and Cancel.
    check('and it asks in the page, not at the browser',
      !/confirm\(`Delete/.test(html) && /className = 'row asking'/.test(html));
    // Cancel first, Delete last, and Done between them on a task. The order is
    // the rule: the way out is where a finger arrives after a leftward swipe,
    // and the one that cannot be taken back is furthest from it.
    check('the way out comes first', /acts\.append\(cancel\);/.test(html));
    check('and the destructive one last, after whatever sits between',
      /acts\.append\(did\);[\s\S]{0,400}acts\.append\(del\);/.test(html));

    // THE THIRD ANSWER, and often the true one: swiping a task away is usually
    // a way of saying "I did this". Done and deleted mean opposite things here
    // and both take the row off the list, so the difference is invisible at the
    // moment you choose and permanent afterwards.
    check('a task can be finished from the question, not only deleted',
      /did\.textContent = 'Done';/.test(html));
    check('and it goes through the same Done as the menu',
      /askOn = null;\s*finish\(item\);/.test(html));
    // Tasks only. A habit recurring is the point of a habit and a project is
    // not finished by one session — the server refuses both, so a button there
    // would be offering a refusal.
    check('offered on a task and nothing else',
      /if \(item\.type === 'task'\) \{[\s\S]{0,400}did\.textContent = 'Done';/.test(html));

    const remove = (html.match(/function remove\(item\) \{[\s\S]*?\n      \}/) || [''])[0];
    check('it offers no undo, because the question was the window',
      Boolean(remove) && !/offerUndo/.test(remove), remove.slice(0, 120));
    check('and no longer goes through the deferred path',
      !/takeOff\(item, 'Deleted'/.test(html));
    check('the write lands at once',
      /apiNow\(`\/entries\/\$\{item\.id\}\/delete`, \{ method: 'POST', keepalive: true \}\)/.test(remove),
      remove.slice(-200));

    // Done kept the undo, and with it the deferred write.
    check('Done still waits for the offer to lapse',
      /offerUndo\([\s\S]{0,700}apiNow\(`\/entries\/\$\{item\.id\}\$\{path\}`/.test(html));

    // apiNow, NOT api, and the difference is the whole reason this write
    // survives a closed tab. `api` awaits a possible token refresh first, and
    // an await inside a pagehide handler is a request that never leaves —
    // keepalive cannot keep alive something that was never started. This
    // caught it once already, as three failing cases in builder-test.
    check('and it goes out without waiting on a refresh first',
      !/offerUndo\([\s\S]{0,700}[^w]api\(`\/entries\/\$\{item\.id\}\$\{path\}`/.test(html));
    check('which is what keeps it alive past a closed tab',
      /keepalive: true/.test(html));
  }

  console.log('\ncleanup');
  server.kill();
  await cleanup();
  await H.cleanup();

  console.log(bad === 0 ? '\nDone and staleness clean' : `\n${bad} FAILURE(S)`);
  process.exitCode = bad === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error('harness error:', e.message);
  if (server) server.kill();
  await cleanup();
  await H.cleanup();
  process.exitCode = 1;
});
