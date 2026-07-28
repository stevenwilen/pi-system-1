// Exercises the Monday task message grouping without touching the database.
const TASK_LIST_LIMIT = 5;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function build(data, today) {
  if (!data || data.length === 0) return '';

  const rank = (t) => (t.priority === null || t.priority === undefined ? 9999 : t.priority);
  const byRank = [...data].sort(
    (a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at)
  );

  const weekEnd = addDays(today, 7);
  const overdue = byRank.filter((t) => t.due && t.due < today);
  const soon = byRank.filter((t) => t.due && t.due >= today && t.due < weekEnd);
  const dated = new Set([...overdue, ...soon]);
  const rest = byRank.filter((t) => !dated.has(t));

  const label = (t) => `${t.priority ? `${t.priority}.` : '•'} ${t.title}`;
  const lines = ['📋 <b>Open tasks</b>', ''];

  if (overdue.length) {
    lines.push('<b>Overdue</b>');
    for (const t of overdue) lines.push(`${label(t)} (was due ${t.due})`);
    lines.push('');
  }
  if (soon.length) {
    lines.push('<b>Due this week</b>');
    for (const t of soon) lines.push(`${label(t)} (due ${t.due})`);
    lines.push('');
  }
  if (rest.length) {
    if (overdue.length || soon.length) lines.push('<b>The rest, by rank</b>');
    for (const t of rest.slice(0, TASK_LIST_LIMIT)) lines.push(label(t));
    const hidden = rest.length - TASK_LIST_LIMIT;
    if (hidden > 0) lines.push(`plus ${hidden} more.`);
  }
  return lines.join('\n').trim();
}

const TODAY = '2026-07-27';
const c = (n) => `2026-07-0${n}T00:00:00Z`;

console.log('=== mixed: overdue, due soon, ranked, unranked ===\n');
console.log(build([
  { title: 'Buy tires', priority: 2, due: '2026-07-24', created_at: c(1) },
  { title: 'Call mechanic', priority: 1, due: '2026-07-28', created_at: c(2) },
  { title: 'UF transfer research', priority: 3, due: null, created_at: c(3) },
  { title: 'Setup Baselang', priority: 4, due: '2026-09-01', created_at: c(4) },
  { title: 'Unranked leftover', priority: null, due: null, created_at: c(5) },
], TODAY));

console.log('\n\n=== nothing dated, more than the limit ===\n');
console.log(build(
  Array.from({ length: 8 }, (_, i) => ({
    title: `Task ${i + 1}`, priority: i + 1, due: null, created_at: c(1),
  })),
  TODAY
));

console.log('\n\n=== boundary: due exactly today and exactly 7 days out ===\n');
console.log(build([
  { title: 'Due today', priority: 1, due: TODAY, created_at: c(1) },
  { title: 'Due in 7 days', priority: 2, due: addDays(TODAY, 7), created_at: c(2) },
  { title: 'Due in 6 days', priority: 3, due: addDays(TODAY, 6), created_at: c(3) },
], TODAY));

console.log('\n\n=== no tasks ===');
console.log(JSON.stringify(build([], TODAY)));
