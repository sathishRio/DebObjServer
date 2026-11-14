import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armKey, planKey, planNotice, taskNotices } from '../src/notifyCore.js';

const D = '2026-11-14';
const T0 = Date.UTC(2026, 10, 14, 0, 0); // treat the local clock as UTC for nowMs
const at = (hhmm, date = D) => {
  const [h, m] = hhmm.split(':').map(Number);
  return [{ date, minutes: h * 60 + m }, T0 + (h * 60 + m) * 60000];
};
const run = (tasks, hhmm, opts = {}) => {
  const [clock, nowMs] = at(hhmm, opts.date);
  return taskNotices(tasks, clock, { nowMs, ...opts });
};
const task = (o) => ({ id: 't1', title: 'Call bank', status: 'todo', dueDate: D, dueTime: null, reminder: false, parentId: null, ...o });
const sent = (t, hhmm, extra = {}) => ({ [t.id]: { armKey: armKey(t), lastSentAt: at(hhmm)[1], ...extra } });

test('reminder fires at its time, not before', () => {
  const t = task({ reminder: true, dueTime: '14:00' });
  assert.equal(run([t], '13:59').alerts.length, 0);
  const [n] = run([t], '14:00').alerts;
  assert.equal(n.kind, 'reminder');
  assert.equal(n.key, 'alert:t1');
  assert.equal(n.body, 'Due at 14:00');
});

test('repeats every 15 minutes until skipped', () => {
  const t = task({ reminder: true, dueTime: '14:00' });
  assert.equal(run([t], '14:10', { states: sent(t, '14:00') }).alerts.length, 0);
  const [n] = run([t], '14:15', { states: sent(t, '14:00') }).alerts;
  assert.ok(n.repeat);
  assert.match(n.body, /\(again\)$/);
  assert.equal(run([t], '16:00', { states: sent(t, '14:00', { skipped: true }) }).alerts.length, 0);
});

test('snooze sets the next alert; a new due time re-arms a skipped task', () => {
  const t = task({ reminder: true, dueTime: '14:00' });
  const snoozed = sent(t, '14:00', { snoozeUntil: at('14:45')[1] });
  assert.equal(run([t], '14:30', { states: snoozed }).alerts.length, 0);
  assert.equal(run([t], '14:45', { states: snoozed }).alerts.length, 1);
  const moved = task({ reminder: true, dueTime: '16:00' });
  assert.equal(run([moved], '16:00', { states: sent(t, '14:00', { skipped: true }) }).alerts.length, 1);
});

test('no repeats overnight; overdue tasks keep alerting next day', () => {
  const t = task({ reminder: true, dueTime: '14:00' });
  assert.equal(run([t], '22:30', { states: sent(t, '21:00') }).alerts.length, 0);
  const [n] = run([t], '09:00', { date: '2026-11-15', states: { t1: { armKey: armKey(t), lastSentAt: T0 } } }).alerts;
  assert.equal(n.kind, 'overdue');
  assert.match(n.body, /^Overdue since 2026-11-14 14:00/);
});

test('timed task without reminder starts 30 minutes ahead', () => {
  const t = task({ dueTime: '15:00' });
  assert.equal(run([t], '14:29').alerts.length, 0);
  assert.equal(run([t], '14:30').alerts[0].kind, 'due_soon');
});

test('an action shows its main task; a task and its actions are one notification', () => {
  const titles = { p: 'Q4 report' };
  const a = task({ id: 'a', title: 'Send draft', parentId: 'p', reminder: true, dueTime: '14:00' });
  const [one] = run([a], '14:00', { titles }).alerts;
  assert.equal(one.title, 'Send draft');
  assert.equal(one.body, 'Q4 report · Due at 14:00');

  const p = task({ id: 'p', title: 'Q4 report', reminder: true, dueTime: '14:00' });
  const b = task({ id: 'b', title: 'Get sign-off', parentId: 'p', reminder: true, dueTime: '14:00' });
  const { alerts } = run([a, p, b], '14:00', { titles });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'alert:p');
  assert.deepEqual(alerts[0].taskIds, ['p', 'a', 'b']);
  assert.equal(alerts[0].body, '3 items: Q4 report, Send draft, Get sign-off · Due at 14:00');
});

test('morning summary counts tasks and actions separately', () => {
  const list = [
    task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c', parentId: 'a' }),
    task({ id: 'd', dueDate: '2026-11-10' }), task({ id: 'e', background: true }),
  ];
  const { digest } = run(list, '08:00');
  assert.equal(digest.body, '2 tasks and 1 action due today, 1 task overdue.');
  assert.equal(run([], '08:00').digest, null);
});

test('Hub plan: alerts for the item scheduled now, repeats until done or skipped', () => {
  const item = { ref: 'item:abc', title: 'Guitar practice', area: 'hobby', minutes: 30, start: 18 * 60 + 30, endTime: '19:00', reason: 'Fits your free time' };
  const plan = { next: item };
  const [early, earlyMs] = at('18:00');
  assert.equal(planNotice({ next: { ...item, start: 18 * 60 + 30 } }, early, earlyMs, null), null); // free time not started
  const [now, nowMs] = at('18:30');
  const n = planNotice(plan, now, nowMs, null);
  assert.equal(n.key, planKey(D, 'item:abc'));
  assert.equal(n.kind, 'plan');
  assert.equal(n.body, 'Free time now · 30 min, until 19:00 · Fits your free time');
  assert.deepEqual(n.plan, { date: D, ref: 'item:abc', area: 'hobby', title: 'Guitar practice', minutes: 30 });
  const state = { armKey: n.key, lastSentAt: nowMs };
  assert.equal(planNotice(plan, ...at('18:40'), state), null);
  assert.ok(planNotice(plan, ...at('18:45'), state).repeat);
  assert.equal(planNotice(plan, ...at('19:30'), { ...state, skipped: true }), null);
  assert.equal(planNotice({ next: null }, now, nowMs, null), null);
});

test('remind me after: minutes typed on the phone', async () => {
  const { parseMinutes } = await import('../src/notifyCore.js');
  assert.equal(parseMinutes(''), 15);
  assert.equal(parseMinutes('20'), 20);
  assert.equal(parseMinutes(' 45 min '), 45);
  assert.equal(parseMinutes('1h'), 60);
  assert.equal(parseMinutes('1h 30m'), 90);
  assert.equal(parseMinutes('1.5 hours'), 90);
  assert.equal(parseMinutes('abc'), null);
  assert.equal(parseMinutes('0'), null);
  assert.equal(parseMinutes('2000'), null);
});

test('local due time to an instant, per time zone', async () => {
  const { utcMsOf } = await import('../src/notifyCore.js');
  assert.equal(new Date(utcMsOf('2026-11-14', '14:30', 'Asia/Kolkata')).toISOString(), '2026-11-14T09:00:00.000Z');
  assert.equal(new Date(utcMsOf('2026-07-01', '09:00', 'Europe/London')).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(new Date(utcMsOf('2026-11-14', '00:15', 'UTC')).toISOString(), '2026-11-14T00:15:00.000Z');
});
