// Summarize: the one place a route reaches the model.
//
// No network and no model call. The reasoning itself is one request with one
// job, so what is worth pinning is everything around it: that it carries no
// tools, that the field text arrives fenced as data, that a refusal is noticed
// before the reply is read, and that nothing reaches the field unless a real
// rewrite came back.
//
// The page half is driven through the shipped script in a fake DOM, because the
// rule that matters there — a failure leaves what you dictated alone — is a
// promise about behaviour, not about markup.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const src = fs.readFileSync(`${ROOT}/summarize.js`, 'utf8');
const routeSrc = fs.readFileSync(`${ROOT}/routes/summarize.js`, 'utf8');

console.log('the call is narrow');
{
  // The brain is the agent loop and holds five tools. This is not that, and the
  // distance between them is the whole safety story: it cannot read the
  // notebook, so it cannot leak it, and it cannot write a row, so a rewrite
  // cannot become a save.
  check('it does not go through the brain', !/runBrain|require\('\.\/brain'\)/.test(src));
  check('it hands the model no tools', !/tools\s*:/.test(src));
  check('and reaches no database', !/require\('\.\/db'\)|supabase/.test(src));
  check('it is the only route that calls a model',
    fs.readdirSync(`${ROOT}/routes`)
      .filter((f) => /anthropic|\.\.\/summarize|runBrain/.test(fs.readFileSync(`${ROOT}/routes/${f}`, 'utf8')))
      .join(',') === 'summarize.js');
}

console.log('\nthe field text is data, not instructions');
{
  check('it is fenced before it is sent', /fence\(text\)/.test(src));
  check('with the shared fencer, not one of its own', /require\('\.\/untrusted'\)/.test(src));
  check('and the prompt says what the fence means', /UNTRUSTED USER DATA|\$\{LABEL\}/.test(src));
  check('an instruction inside it is treated as a sentence',
    /cannot give you an instruction/i.test(src));
}

console.log('\nthe prompt states the rules the brief set');
{
  const prompt = src.slice(src.indexOf('const SYSTEM_PROMPT'), src.indexOf('*/', src.indexOf('const SYSTEM_PROMPT')) + 2);
  check('never a question', /never ask a question/i.test(prompt));
  check('never a conversation', /never address the person|never comment on the text/i.test(prompt));
  check('meaning and specifics kept exactly', /keep their meaning and their specifics exactly/i.test(prompt));
  check('nothing added', /add nothing/i.test(prompt));
  check('filler and false starts stripped', /filler, repetition and false starts/i.test(prompt));
  check('one or two sentences', /one or two sentences/i.test(prompt));
  check('first person, plain language', /first person, in plain language/i.test(prompt));
  check('no headers or bullets', /no headers, no bullet points/i.test(prompt));
}

console.log('\nnothing half-written ever reaches the field');
{
  check('a refusal is caught before the reply is read',
    src.indexOf("stop_reason === 'refusal'") < src.indexOf('.filter((block) => block.type'),
    'refusal check must come first');
  check('an empty reply is a failure, not a blank field', /if \(!out\) throw/.test(src));
  check('and every failure throws rather than returning something', !/return ''/.test(src));
  check('the route says the text is unchanged', /Your text is unchanged/.test(routeSrc));
}

console.log('\nthe cost is recorded under its own name');
{
  check('usage is recorded', /recordUsage\(user_id, 'summarize'/.test(src));
  const pricing = fs.readFileSync(`${ROOT}/usage.js`, 'utf8');
  const model = src.match(/const MODEL = '([^']+)'/)[1];
  check(`${model} is priced, so it is not billed at the fallback's rate`,
    new RegExp(`'${model}':`).test(pricing), model);
}

// --- the route ---------------------------------------------------------------
//
// No harness, and none needed. This suite cannot reach a row: routes/summarize
// imports only express, ../user and ../summarize, none of which opens a
// database client, and ../summarize — the one file here that pulls in usage.js
// and so db.js — is replaced below before the route is ever loaded. So
// requiring the route constructs no model client, needs no key, and has nothing
// to write to.
const MAX_INPUT = Number(src.match(/const MAX_INPUT = (\d+)/)[1]);

let fake = async () => 'tidied';
const stub = require.resolve(ROOT + '/summarize.js');
require.cache[stub] = {
  id: stub,
  filename: stub,
  loaded: true,
  exports: { summarize: (...a) => fake(...a), MAX_INPUT },
};

const router = require(ROOT + '/routes/summarize');
const handler = router.stack.find((l) => l.route && l.route.path === '/summarize').route.stack[0].handle;

async function post(body) {
  let status = 200;
  let payload = null;
  const res = {
    status(c) { status = c; return this; },
    json(p) { payload = p; return this; },
  };
  await handler({ body }, res);
  return { status, payload };
}

(async () => {
  console.log('\nthe route answers what it can without a call');
  {
    let called = 0;
    fake = async () => { called++; return 'tidied'; };

    const empty = await post({ text: '   ' });
    check('an empty field is refused', empty.status === 400, String(empty.status));
    check('and no call was spent on it', called === 0, `${called} call(s)`);

    const missing = await post({});
    check('a missing field is refused too', missing.status === 400, String(missing.status));

    const long = await post({ text: 'x'.repeat(MAX_INPUT + 1) });
    check('a runaway paste is refused', long.status === 400, String(long.status));
    check('still without a call', called === 0, `${called} call(s)`);
  }

  console.log('\nand hands back the rewrite when there is one');
  {
    let seen = null;
    fake = async (user, text) => { seen = text; return 'Building a second income so I am not living paycheck to paycheck.'; };

    const spoken = 'um so basically the thing is I want to like build this business because you know I don\'t want to be paycheck to paycheck';
    const ok = await post({ text: spoken });

    check('it answers 200', ok.status === 200, String(ok.status));
    check('with the rewritten text', ok.payload.text.startsWith('Building a second income'), ok.payload.text);
    check('and passed the field through untouched', seen === spoken);
  }

  console.log('\na failed call is a 502 that changes nothing');
  {
    fake = async () => { throw new Error('overloaded'); };
    const failed = await post({ text: 'something real' });
    check('it answers 502', failed.status === 502, String(failed.status));
    check('it says so quietly', /unchanged/.test(failed.payload.error), failed.payload.error);
    check('and does not leak the reason to the screen', !/overloaded/.test(failed.payload.error));
  }

  // --- the page ---------------------------------------------------------------

  class El {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.dataset = {}; this.style = {};
      this._class = new Set(); this.textContent = ''; this.value = ''; this.disabled = false;
      this._attrs = {};
      this.classList = {
        add: (c) => this._class.add(c), remove: (c) => this._class.delete(c),
        contains: (c) => this._class.has(c),
        toggle: (c, f) => { const on = f === undefined ? !this._class.has(c) : f; on ? this._class.add(c) : this._class.delete(c); return on; },
      };
    }
    get className() { return [...this._class].join(' '); }
    set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
    append(...k) { for (const x of k) if (x) this.children.push(x); }
    replaceChildren(...k) { this.children = k.filter(Boolean); }
    appendChild(k) { this.children.push(k); return k; }
    setAttribute(k, v) { this._attrs[k] = v; if (k === 'class') this.className = v; }
    getAttribute(k) { return this._attrs[k]; }
    focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
    addEventListener() {} removeEventListener() {}
    getBoundingClientRect() { return { top: 0, height: 40 }; }
    closest() { return this; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }

  const html = fs.readFileSync(`${ROOT}/public/index.html`, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const ids = [...new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))];
  const byId = {};
  for (const id of ids) byId[id] = new El();
  byId['ends'].querySelector = () => new El();
  for (const t of ['habit', 'project', 'task']) {
    const b = new El('button'); b.dataset.type = t; byId['type-seg'].append(b);
  }

  // What the stubbed endpoint does next.
  let reply = { ok: true, body: { text: 'Building a second income so I am not living paycheck to paycheck.' } };
  let sentText = null;

  const ctx = vm.createContext({
    console, setTimeout, requestAnimationFrame: (f) => setTimeout(f, 0),
    Intl, Date, Math, JSON, String, Number, Boolean, Array, Object, Set, Map,
    alert: () => {}, confirm: () => true,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, opts) => {
      const u = String(url);
      if (u === '/summarize') {
        sentText = JSON.parse(opts.body).text;
        return { ok: reply.ok, json: async () => reply.body };
      }
      return {
        ok: true,
        json: async () => {
          if (u.startsWith('/calendar')) return { events: [], all_day: [] };
          if (u.startsWith('/plan/')) return { plan: null, blocks: [] };
          if (u.startsWith('/review')) return { date: '2026-07-26', blocks: [] };
          if (opts && opts.method === 'POST') return { ok: true };
          return { today: '2026-07-28', timezone: 'UTC', wake_time: '08:00', items: [], paused: [] };
        },
      };
    },
    document: {
      getElementById: (id) => byId[id],
      createElement: (t) => new El(t),
      createElementNS: (ns, t) => new El(t),
    },
  });

  vm.runInContext(script, ctx);

  const why = byId['f-why'];
  const btn = byId['why-summarize'];
  const undo = byId['why-undo'];
  const note = byId['why-note'];
  const SPOKEN = "um so basically the thing is I want to like build this business because you know I don't want to be paycheck to paycheck";
  const CLEAN = 'Building a second income so I am not living paycheck to paycheck.';

  console.log('\nthe button is off until there is something to work on');
  {
    ctx.openEntry({ id: 'p1', type: 'project', title: 'Business', why: '' });
    check('disabled on an empty field', btn.disabled === true);
    check('and no undo is offered', undo._class.has('hidden'));

    why.value = SPOKEN;
    why.oninput();
    check('enabled once something is dictated', btn.disabled === false);
  }

  console.log('\none tap replaces the field in place');
  {
    reply = { ok: true, body: { text: CLEAN } };
    const running = btn.onclick();
    check('it says it is working', btn.textContent === 'Summarizing…', btn.textContent);
    check('and cannot be tapped twice', btn.disabled === true);
    await running;

    check('the spoken text was sent', sentText === SPOKEN);
    check('the field holds the clean version', why.value === CLEAN, why.value);
    check('the button is itself again', btn.textContent === 'Summarize' && btn.disabled === false);
    check('and an undo is offered', !undo._class.has('hidden'));
  }

  console.log('\nthe original is recoverable');
  {
    undo.onclick();
    check('undo puts back what was dictated', why.value === SPOKEN, why.value);
    check('and stops offering itself', undo._class.has('hidden'));
  }

  console.log('\nthe undo does not outlive the text it would restore');
  {
    why.value = SPOKEN;
    why.oninput();
    await btn.onclick();
    check('offered after a rewrite', !undo._class.has('hidden'));

    why.value = CLEAN + ' And a bit more.';
    why.oninput();
    check('withdrawn once the field is edited again', undo._class.has('hidden'));

    why.value = SPOKEN;
    why.oninput();
    await btn.onclick();
    check('offered again after the next rewrite', !undo._class.has('hidden'));
    ctx.closeEntry();
    check('and withdrawn when the sheet closes', undo._class.has('hidden'));
  }

  console.log('\na failure leaves every word alone');
  {
    ctx.openEntry({ id: 'p1', type: 'project', title: 'Business', why: SPOKEN });
    reply = { ok: false, body: { error: 'Could not tidy that up. Your text is unchanged.' } };

    await btn.onclick();

    check('the field is untouched', why.value === SPOKEN, why.value);
    check('it is never cleared', why.value.length > 0);
    check('it says so quietly', !note._class.has('hidden') && /unchanged/.test(note.textContent), note.textContent);
    check('no undo is offered, since nothing was replaced', undo._class.has('hidden'));
    check('and the button works again', btn.disabled === false && btn.textContent === 'Summarize');

    // The note is an answer to the last tap, not a permanent state.
    why.value = SPOKEN + ' more';
    why.oninput();
    check('the note clears when typing resumes', note._class.has('hidden'));
  }

  console.log('\nthe field stays dictation-friendly');
  {
    const field = html.match(/<textarea id="f-why"[^>]*>/)[0];
    check('a plain multiline box', /^<textarea /.test(field) && !/type=/.test(field), field);
    check('autocapitalise left on', /autocapitalize="sentences"/.test(field), field);
    check('and no autocomplete fighting the keyboard', !/autocomplete/.test(field), field);
    check('nothing intercepts keys on it', !/f-why'\)\.onkey|f-why'\)\.onbeforeinput/.test(script));
  }

  console.log(bad === 0 ? '\nSummarize clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})();
