// The warning marks. Pure arithmetic, so pure fixtures: no database, no
// network, no server.
//
// Every band boundary is pinned on both sides. The bands are the only place
// this system says anything is urgent, and an off-by-one here moves a row into
// or out of the miss colour without anything looking wrong.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

const { markFor, daysUntil, DAYS_NEEDED, SIZES } = require(ROOT + '/warning.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const TODAY = '2026-07-28';
const day = (n) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// slack = daysUntil - daysNeeded, so this puts the deadline exactly `slack`
// days beyond what the size needs.
const atSlack = (size, slack) =>
  markFor({ due: day(DAYS_NEEDED[size] + slack), size, today: TODAY });

(async () => {
  console.log('the size table');
  {
    check('five buckets, no more', SIZES.length === 5, SIZES.join(', '));
    check('a day is 1', DAYS_NEEDED['a day'] === 1);
    check('a few days is 3', DAYS_NEEDED['a few days'] === 3);
    check('a week is 6', DAYS_NEEDED['a week'] === 6);
    check('a few weeks is 15', DAYS_NEEDED['a few weeks'] === 15);
    check('months is 40', DAYS_NEEDED['months'] === 40);
  }

  console.log('\nthe bands, on every boundary');
  {
    // Checked against all five sizes: a band must be a fact about the slack,
    // not about which bucket happened to produce it.
    for (const size of SIZES) {
      const at = (slack) => atSlack(size, slack);

      const wrong = [
        [-5, '!!!'], [-1, '!!!'], [0, '!!!'],
        [1, '!!'], [2, '!!'], [3, '!!'],
        [4, '!'], [7, '!'], [10, '!'],
        [11, null], [40, null],
      ].filter(([slack, want]) => at(slack) !== want);

      check(
        `${size}: every band lands where it should`,
        wrong.length === 0,
        wrong.map(([s, w]) => `slack ${s} wanted ${w} got ${at(s)}`).join('; ')
      );
    }
  }

  console.log('\nthe boundaries specifically');
  {
    check('slack 0 is the worst mark, not the second', atSlack('a week', 0) === '!!!');
    check('slack 1 steps down to two', atSlack('a week', 1) === '!!');
    check('slack 3 is still two', atSlack('a week', 3) === '!!');
    check('slack 4 steps down to one', atSlack('a week', 4) === '!');
    check('slack 10 is still one', atSlack('a week', 10) === '!');
    check('slack 11 is quiet', atSlack('a week', 11) === null);
  }

  console.log('\noverdue is the most urgent thing the scale can say');
  {
    check('a deadline in the past marks', markFor({ due: day(-1), size: 'a day', today: TODAY }) === '!!!');
    check('long past marks the same', markFor({ due: day(-90), size: 'months', today: TODAY }) === '!!!');
    check('due today with a day of work marks', markFor({ due: TODAY, size: 'a day', today: TODAY }) === '!!!');
  }

  console.log('\nnothing to say is said as nothing');
  {
    check('no due date, no mark', markFor({ due: null, size: 'a week', today: TODAY }) === null);
    check('no size, no mark', markFor({ due: day(2), size: null, today: TODAY }) === null);
    check('neither, no mark', markFor({ due: null, size: null, today: TODAY }) === null);
    check('a size it does not know, no mark',
      markFor({ due: day(1), size: 'quite big', today: TODAY }) === null);
    check('an empty string size, no mark', markFor({ due: day(1), size: '', today: TODAY }) === null);
  }

  console.log('\nthe day count itself');
  {
    check('forward', daysUntil(TODAY, day(6)) === 6, String(daysUntil(TODAY, day(6))));
    check('backward is negative', daysUntil(TODAY, day(-3)) === -3, String(daysUntil(TODAY, day(-3))));
    check('same day is zero', daysUntil(TODAY, TODAY) === 0);

    // Noon-to-noon, so a date either side of a daylight saving change is still
    // a whole number of days apart.
    check('across a spring forward', daysUntil('2026-03-07', '2026-03-09') === 2,
      String(daysUntil('2026-03-07', '2026-03-09')));
    check('across an autumn back', daysUntil('2026-10-31', '2026-11-02') === 2,
      String(daysUntil('2026-10-31', '2026-11-02')));
    check('across a year end', daysUntil('2026-12-30', '2027-01-02') === 3,
      String(daysUntil('2026-12-30', '2027-01-02')));
  }

  console.log('\nthe mark does not model anything');
  {
    // Comments stripped first. The file explains at length that it does not
    // model capacity or progress, and a check reading the raw text would fail
    // precisely because the reasoning was written down.
    const src = require('fs')
      .readFileSync(ROOT + '/warning.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    check('no model call', !/runBrain|anthropic|fetch\(/i.test(src));
    check('no database', !/supabase|require\('\.\/db'\)/.test(src));
    check('nothing about completion or capacity', !/completed|progress|capacity|hours/i.test(src));
    check('it reads two inputs and subtracts', /due/.test(src) && /size/.test(src) && /-/.test(src));
  }

  console.log(bad === 0 ? '\nWarning marks clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})();
