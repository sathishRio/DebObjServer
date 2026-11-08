import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  areaDeficits, buildSchedule, careerCandidates, DEFAULT_SETTINGS, freeWindows, itemCandidates, itemDueOn, localDate, planDay, weekdayOf,
} from '../src/plannerCore.js';

const S = DEFAULT_SETTINGS; // sleep 23:00-07:00, office Mon-Fri 09:00-18:00, 30 min buffer
const MON = '2026-11-09';
const SAT = '2026-11-14';
const span = (w) => w.map((x) => [x.start, x.end]);

test('weekday is Monday-first', () => {
  assert.equal(weekdayOf(MON), 0);
  assert.equal(weekdayOf(SAT), 5);
});

test('workday: free before and after office, sleep crosses midnight', () => {
  assert.deepEqual(span(freeWindows(S, MON)), [[420, 510], [1110, 1380]]); // 07:00-08:30, 18:30-23:00
});

test('day off: free from waking to sleep', () => {
  assert.deepEqual(span(freeWindows(S, SAT)), [[420, 1380]]);
});

test('sleep that does not cross midnight', () => {
  const s = { ...S, sleep: { start: '01:00', end: '08:00' }, office: Array(7).fill(null) };
  assert.deepEqual(span(freeWindows(s, SAT)), [[0, 60], [480, 1440]]);
});

test('busy blocks overlap office and each other; short gaps are dropped', () => {
  const busy = [{ start: '18:00', end: '19:00' }, { start: '18:45', end: '20:00' }, { start: '20:10', end: '21:00' }];
  assert.deepEqual(span(freeWindows(S, MON, busy)), [[420, 510], [1260, 1380]]); // 20:00-20:10 is under 15 min
});

test('now cuts off time already passed', () => {
  assert.deepEqual(span(freeWindows(S, MON, [], 1200)), [[1200, 1380]]);
  assert.deepEqual(freeWindows(S, MON, [], 1375), []);
});

test('DST-change dates use wall-clock times', () => {
  assert.deepEqual(span(freeWindows(S, '2026-03-29')), [[420, 1380]]); // a Sunday when Europe changes clocks
});

test('recurrence', () => {
  const daily = { active: true, repeat: 'daily' };
  const weekly = { active: true, repeat: 'weekly', days: [0, 2] };
  const once = { active: true, repeat: 'none' };
  assert.ok(itemDueOn(daily, SAT));
  assert.ok(itemDueOn(weekly, MON));
  assert.ok(!itemDueOn(weekly, SAT));
  assert.ok(itemDueOn(once, SAT));
  assert.ok(!itemDueOn({ ...once, completedAt: new Date() }, SAT));
  assert.ok(!itemDueOn({ ...daily, active: false }, SAT));
});

test('item candidates: overdue first tier, logged items hidden', () => {
  const items = [
    { _id: 'a', area: 'home', title: 'Bills', minutes: 20, active: true, repeat: 'none', dueDate: '2026-11-01' },
    { _id: 'b', area: 'health', title: 'Walk', minutes: 30, active: true, repeat: 'daily' },
    { _id: 'c', area: 'project', title: 'App', minutes: 60, active: true, repeat: 'none' },
  ];
  const c = itemCandidates(items, MON, new Set(['item:c']));
  assert.deepEqual(c.map((x) => [x.key, x.tier]), [['item:a', 0], ['item:b', 1]]);
  assert.match(c[0].reason, /Overdue/);
});

test('career: close certification, current phase topic with skill match, next Learn session', () => {
  const c = careerCandidates({
    date: MON,
    profile: { skillPriorities: ['Python'] },
    phases: [
      { _id: 'p1', order: 1, title: 'Done phase', topics: [{ _id: 't0', title: 'Old', done: true }] },
      { _id: 'p2', order: 2, title: 'AI basics', topics: [{ _id: 't1', title: 'Python async', done: false }] },
    ],
    certifications: [
      { _id: 'c1', code: 'AI-102', status: 'studying', targetDate: '2026-11-30' },
      { _id: 'c2', code: 'FAR', status: 'planned', targetDate: '2027-06-01' },
      { _id: 'c3', code: 'OLD', status: 'passed', targetDate: '2026-11-10' },
    ],
    learn: { course: 'ai-journey', courseTitle: 'AI Journey', minutes: 60, session: { week: 3, day: 1, title: 'RAG' } },
  });
  assert.deepEqual(c.map((x) => x.key), ['cert:c1', 'topic:p2:t1', 'learn:ai-journey:3-1']);
  assert.match(c[0].reason, /21 days/);
  assert.match(c[1].reason, /AI basics.*Python/);
});

test('area balance: an area with no time this week needs it most', () => {
  const d = areaDeficits({ learning: 300, health: 0, project: 60, home: 60 }, S.weights);
  assert.ok(d.health > d.project && d.learning < 0);
});

test('schedule: due items first, balance spreads areas, long items do not fit', () => {
  const windows = [{ start: 1110, end: 1380, minutes: 270 }];
  const cands = [
    { key: 'l1', area: 'learning', title: 'Learn A', minutes: 60, tier: 2, priority: 1 },
    { key: 'l2', area: 'learning', title: 'Learn B', minutes: 60, tier: 2, priority: 1 },
    { key: 'h', area: 'health', title: 'Walk', minutes: 30, tier: 2, priority: 2 },
    { key: 'd', area: 'home', title: 'Bills', minutes: 20, tier: 0, priority: 3, reason: 'Due today' },
    { key: 'big', area: 'project', title: 'Rebuild', minutes: 300, tier: 2, priority: 1 },
  ];
  const { scheduled, unplaced } = buildSchedule(windows, cands, { learning: 0, health: 0, project: 0, home: 0 }, S.weights);
  assert.equal(scheduled[0].key, 'd');
  assert.equal(scheduled[0].startTime, '18:30');
  assert.deepEqual(unplaced.map((x) => x.key), ['big']);
  // Learning (50%) leads, but health gets time before the second learning block.
  const order = scheduled.map((x) => x.key);
  assert.ok(order.indexOf('h') < order.indexOf('l2'));
  for (let i = 1; i < scheduled.length; i++) assert.ok(scheduled[i].start >= scheduled[i - 1].end);
});

test('planDay: totals and next item', () => {
  const p = planDay({ settings: S, date: SAT, now: 600, candidates: [{ key: 'h', area: 'health', title: 'Walk', minutes: 30, tier: 1 }] });
  assert.equal(p.freeMinutes, 1380 - 600);
  assert.equal(p.next.key, 'h');
  assert.equal(p.next.startTime, '10:00');
});

test('local date around midnight follows the time zone', () => {
  const instant = '2026-11-08T20:30:00Z';
  assert.equal(localDate(instant, 'Asia/Kolkata'), '2026-11-09'); // 02:00 next day
  assert.equal(localDate(instant, 'America/New_York'), '2026-11-08');
  assert.equal(localDate(instant, 'Not/AZone'), '2026-11-08'); // falls back to UTC
});

test('career: undated certifications only when studying; skills match on key words', () => {
  const c = careerCandidates({
    date: MON,
    profile: { skillPriorities: ['Integration / API Architecture', 'Data Engineering (optional)'] },
    phases: [{ _id: 'p', order: 1, title: 'Integration', topics: [{ _id: 't', title: 'REST API design', done: false }] }],
    certifications: [
      { _id: 'a', code: 'AZ-204', status: 'planned', targetDate: null },
      { _id: 'b', code: 'AI-102', status: 'studying', targetDate: null },
    ],
  });
  assert.deepEqual(c.map((x) => x.key), ['cert:b', 'topic:p:t']);
  assert.match(c[1].reason, /skill priority: Integration \/ API Architecture/);
  // "optional" in brackets is not a key word, so it can't match by itself.
  const d = careerCandidates({ date: MON, profile: { skillPriorities: ['Data Engineering (optional)'] }, phases: [{ _id: 'p', topics: [{ _id: 't', title: 'Optional reading' }] }] });
  assert.doesNotMatch(d[0].reason, /skill priority/);
});

test('reminder: once per local day, inside its window, in the user time zone', async () => {
  const { reminderDue, localClock, reminderMessage } = await import('../src/plannerCore.js');
  const r = { enabled: true, time: '07:30', tz: 'Asia/Kolkata', lastSentOn: null };
  assert.deepEqual(localClock('2026-11-09T02:00:00Z', 'Asia/Kolkata'), { date: '2026-11-09', minutes: 450 }); // 07:30 IST
  assert.equal(reminderDue(r, '2026-11-09T01:59:00Z'), null); // 07:29
  assert.deepEqual(reminderDue(r, '2026-11-09T02:00:00Z'), { date: '2026-11-09', minutes: 450 });
  assert.equal(reminderDue({ ...r, lastSentOn: '2026-11-09' }, '2026-11-09T03:00:00Z'), null); // already sent
  assert.equal(reminderDue(r, '2026-11-09T05:00:00Z'), null); // 10:30, past the 3-hour window
  assert.equal(reminderDue({ ...r, enabled: false }, '2026-11-09T02:00:00Z'), null);
  // Same instant is still the previous evening in New York.
  assert.equal(reminderDue({ ...r, tz: 'America/New_York' }, '2026-11-09T02:00:00Z'), null);
  assert.deepEqual(reminderMessage({ freeMinutes: 90, next: { startTime: '18:30', title: 'Walk' } }), { title: '1h 30m free today', body: 'First up at 18:30: Walk' });
});
