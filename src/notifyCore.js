import { localClock } from './plannerCore.js';

// Which notifications the tasks call for right now. Pure, so it is easy to test.
// `clock` is the user's local { date: 'YYYY-MM-DD', minutes since midnight }; `nowMs` is the real instant.
//
// Alerts: a task starts alerting at its reminder time (reminder on: due time, or 09:00 without one) or
// 30 minutes before its due time (no reminder, but a time). It then repeats every 15 minutes until it
// is done or skipped; a snooze sets the next one. A main task and its actions alerting together are
// one notification. Changing the due date/time re-arms a skipped task.

export const WINDOW = 180; // a first alert still goes out up to 3 hours late (server restart)
export const SOON = 30; // lead time for timed tasks without a reminder
export const REPEAT = 15; // minutes between repeats
export const DIGEST_AT = 8 * 60; // morning summary at 08:00
export const DEFAULT_REMINDER = '09:00';
export const QUIET = { from: 22 * 60, to: 7 * 60 }; // no repeats overnight
export const MAX_OVERDUE_DAYS = 3; // older overdue tasks only show in the morning summary

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const dayNum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const idOf = (t) => String(t.id || t._id);
const isQuiet = (m) => m >= QUIET.from || m < QUIET.to;

// The minute (on its due date) a task starts alerting, or null if it never does.
export function alertAt(t) {
  if (!t.dueDate || t.status === 'done') return null;
  if (t.reminder) return toMin(t.dueTime || DEFAULT_REMINDER);
  if (t.dueTime && !t.background) return toMin(t.dueTime) - SOON;
  return null;
}

// Identifies one schedule of a task: skip and snooze apply to it, a new date/time starts fresh.
export const armKey = (t) => `${t.dueDate}|${t.dueTime || ''}|${t.reminder ? 'r' : 's'}`;

// Should this task alert now? `state` = { armKey, lastSentAt (ms), snoozeUntil (ms), skipped }.
function shouldAlert(t, { date, minutes }, nowMs, state) {
  const at = alertAt(t);
  if (at === null) return false;
  const late = dayNum(date) - dayNum(t.dueDate);
  if (late < 0 || late > MAX_OVERDUE_DAYS || (late === 0 && minutes < at)) return false;
  const fresh = !state || state.armKey !== armKey(t);
  if (!fresh && state.skipped) return false;
  if (fresh) {
    // A first alert on time is always sent; a catch-up (old or late) waits for daytime.
    const onTime = late === 0 && minutes < at + WINDOW;
    return onTime || !isQuiet(minutes);
  }
  if (isQuiet(minutes)) return false;
  return repeatDue(state, nowMs);
}

// A repeat is due 15 minutes after the last send, or when the snooze ends.
const repeatDue = (state, nowMs) => nowMs >= Math.max((state.lastSentAt || 0) + REPEAT * 60000, state.snoozeUntil || 0);

// Hub "Today": the plan item scheduled in free time right now. The plan is rebuilt from the current
// time, so an item that is not done or skipped stays first and keeps alerting every 15 minutes.
// Outside free time (office, sleep, busy blocks) the next item starts later, so nothing is sent.
// `state` is the alert state for planKey(date, ref).
export const planKey = (date, ref) => `plan:${date}:${ref}`;
export function planNotice(plan, { date, minutes }, nowMs, state) {
  const next = plan?.next;
  if (!next || next.start > minutes) return null;
  const key = planKey(date, next.ref);
  const repeat = state?.armKey === key;
  if (repeat && (state.skipped || !repeatDue(state, nowMs))) return null;
  const body = `Free time now · ${next.minutes} min, until ${next.endTime}${next.reason ? ` · ${next.reason}` : ''}`;
  return {
    key, kind: 'plan', title: next.title, body: repeat ? `${body} (again)` : body, repeat, url: '/#/planner', taskIds: [],
    ends: { date, time: next.endTime },
    plan: { date, ref: next.ref, area: next.area, title: next.title, minutes: next.minutes },
  };
}

function timing(t, date) {
  if (t.dueDate < date) return `Overdue since ${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ''}`;
  return t.dueTime ? `Due at ${t.dueTime}` : 'Due today';
}

// tasks: open tasks with a due date. titles: id -> title for every task (to name parents).
// states: taskId -> state. Returns { alerts, digest }.
export function taskNotices(tasks, clock, { nowMs = Date.now(), states = {}, titles = {} } = {}) {
  const open = tasks.filter((t) => t.status !== 'done');
  const due = open.filter((t) => shouldAlert(t, clock, nowMs, states[idOf(t)]));

  // One notification per main task: the task itself and/or its actions.
  const groups = new Map();
  for (const t of due) {
    const root = t.parentId ? String(t.parentId) : idOf(t);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  const alerts = [...groups].map(([root, list]) => {
    list.sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || (a.dueTime || '').localeCompare(b.dueTime || ''));
    const parentTitle = titles[root] || list.find((t) => idOf(t) === root)?.title;
    const repeat = list.every((t) => states[idOf(t)]?.armKey === armKey(t));
    const kind = list.some((t) => t.dueDate < clock.date) ? 'overdue' : list.some((t) => t.reminder) ? 'reminder' : 'due_soon';
    let title;
    let body;
    if (list.length === 1) {
      const [t] = list;
      title = t.title;
      body = t.parentId && parentTitle ? `${parentTitle} · ${timing(t, clock.date)}` : timing(t, clock.date);
    } else {
      title = parentTitle || list[0].title;
      body = `${list.length} items: ${list.map((t) => t.title).join(', ')} · ${timing(list[0], clock.date)}`;
    }
    const first = list.find((t) => t.dueTime) || null;
    return {
      key: `alert:${root}`, kind, title, body: repeat ? `${body} (again)` : body, repeat,
      due: first ? { date: first.dueDate, time: first.dueTime } : null, // the phone's timer counts to (or from) it
      taskId: list.length === 1 ? idOf(list[0]) : root, taskIds: list.map(idOf), url: '/#/tasks',
    };
  });

  // Morning summary: main tasks and actions counted separately.
  let digest = null;
  if (clock.minutes >= DIGEST_AT && clock.minutes < DIGEST_AT + WINDOW) {
    const visible = open.filter((t) => !t.background && t.dueDate);
    const count = (list) => {
      const main = list.filter((t) => !t.parentId).length;
      const actions = list.length - main;
      return [main && plural(main, 'task'), actions && plural(actions, 'action')].filter(Boolean).join(' and ');
    };
    const today = visible.filter((t) => t.dueDate === clock.date);
    const overdue = visible.filter((t) => t.dueDate < clock.date);
    if (today.length || overdue.length) {
      const parts = [today.length && `${count(today)} due today`, overdue.length && `${count(overdue)} overdue`].filter(Boolean);
      digest = {
        key: `digest:${clock.date}`, kind: overdue.length ? 'overdue' : 'digest', taskId: null, taskIds: [], url: '/#/tasks',
        title: overdue.length ? 'Tasks need attention' : 'Your tasks today', body: `${parts.join(', ')}.`,
      };
    }
  }
  return { alerts, digest };
}

// "Remind me after" from the phone: "20", "20m", "1h", "1h 30m", "90 min". Empty = REPEAT. Null if unreadable.
export function parseMinutes(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return REPEAT;
  const m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*(?:m|mins?|minutes?)?)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const total = Math.round((m[1] ? Number(m[1]) * 60 : 0) + (m[2] ? Number(m[2]) : 0));
  return total >= 1 && total <= 1440 ? total : null;
}

// The instant (ms) of a local date and HH:MM in a time zone.
export function utcMsOf(date, hhmm, tz) {
  const target = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), ...hhmm.split(':').map(Number));
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const c = localClock(guess, tz);
    const seen = Date.UTC(+c.date.slice(0, 4), +c.date.slice(5, 7) - 1, +c.date.slice(8, 10)) + c.minutes * 60000;
    guess += target - seen;
  }
  return guess;
}
