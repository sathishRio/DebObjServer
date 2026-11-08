// Planner logic: free time and "what to do next". Pure functions (no database), so they are easy to test.
// Times are wall-clock minutes of the user's local day (0 = midnight, 1440 = next midnight), which
// keeps daylight-saving changes from shifting office or sleep hours.

export const AREAS = ['learning', 'health', 'project', 'home'];
export const AREA_LABELS = { learning: 'Learning & career', health: 'Health & habits', project: 'Side projects', home: 'Home & family' };
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_SETTINGS = {
  sleep: { start: '23:00', end: '07:00' },
  // 0 = Monday … 6 = Sunday; null = no office that day.
  office: [0, 1, 2, 3, 4].map(() => ({ start: '09:00', end: '18:00' })).concat([null, null]),
  bufferMinutes: 30, // travel / wind-down around office hours
  minWindow: 15, // free gaps shorter than this are ignored
  weights: { learning: 50, health: 17, project: 17, home: 16 },
};

export const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};
export const toTime = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Monday = 0 for a YYYY-MM-DD date.
export const weekdayOf = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

export const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

export function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

// The user's local date for an instant (e.g. when a Learn session was finished).
export const localDate = (instant, tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: validTz(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));

// Merge overlapping [start, end] intervals.
function merge(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// Blocked time for one date: sleep (which may cross midnight), office plus buffer, one-off busy blocks.
export function blockedTime(settings, date, busy = []) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const out = [];
  const a = toMin(s.sleep.start);
  const b = toMin(s.sleep.end);
  if (a > b) out.push([0, b], [a, 1440]);
  else out.push([a, b]);
  const office = s.office?.[weekdayOf(date)];
  if (office) out.push([Math.max(0, toMin(office.start) - s.bufferMinutes), Math.min(1440, toMin(office.end) + s.bufferMinutes)]);
  for (const x of busy) out.push([toMin(x.start), toMin(x.end)]);
  return merge(out);
}

// Free windows for a date, from `now` (minutes) onward when given.
export function freeWindows(settings, date, busy = [], now = 0) {
  const minWindow = settings?.minWindow ?? DEFAULT_SETTINGS.minWindow;
  const free = [];
  let cursor = Math.max(0, now);
  for (const [s, e] of blockedTime(settings, date, busy)) {
    if (s > cursor) free.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < 1440) free.push([cursor, 1440]);
  return free.filter(([s, e]) => e - s >= minWindow).map(([s, e]) => ({ start: s, end: e, minutes: e - s }));
}

// Is this planner item due on `date`?
export function itemDueOn(item, date) {
  if (!item.active) return false;
  const r = item.repeat || 'none';
  if (r === 'daily') return true;
  if (r === 'weekly') return (item.days || []).includes(weekdayOf(date));
  return !item.completedAt; // one-off: until it is done
}

// Turn the user's planner items into candidates for today (logged = keys already done/skipped today).
export function itemCandidates(items, date, logged = new Set()) {
  return items
    .filter((it) => itemDueOn(it, date) && !logged.has(`item:${it._id}`))
    .map((it) => {
      const recurring = (it.repeat || 'none') !== 'none';
      const overdue = !recurring && it.dueDate && it.dueDate < date;
      const dueToday = !recurring && it.dueDate === date;
      return {
        key: `item:${it._id}`,
        area: it.area,
        title: it.title,
        minutes: it.minutes,
        priority: it.priority ?? 2,
        tier: overdue || dueToday ? 0 : recurring ? 1 : 2,
        reason: overdue ? `Overdue since ${it.dueDate}` : dueToday ? 'Due today' : recurring ? 'Part of your routine' : '',
        recurring,
      };
    });
}

// Career suggestions from the profile, roadmap phases, certifications and the next Learn session.
// `order` ranks them within the learning area (lower first).
export function careerCandidates({ profile, phases = [], certifications = [], learn, date, logged = new Set() }) {
  const out = [];
  const skills = (profile?.skillPriorities || []).map((s) => s.trim()).filter(Boolean);
  // A skill matches when one of its key words (e.g. "API" in "Integration / API Architecture") is in the text.
  const STOP = new Set(['and', 'the', 'for', 'with', 'low', 'priority', 'optional', 'pure']);
  const words = (t) => t.toLowerCase().split(/[^a-z0-9#+.]+/).filter((w) => w.length >= 2 && !STOP.has(w));
  const matchSkill = (text) => {
    const have = new Set(words(text));
    return skills.find((s) => words(s.replace(/\(.*?\)/g, '')).some((w) => have.has(w)));
  };

  for (const c of certifications) {
    if (c.status === 'passed') continue;
    // Without a target date, only certifications you are actively working on are suggested.
    const active = c.status === 'studying' || c.status === 'scheduled';
    if (!c.targetDate) {
      if (!active) continue;
      out.push({
        key: `cert:${c._id}`, area: 'learning', title: `Prepare for ${c.code}${c.name ? `: ${c.name}` : ''}`, minutes: 45,
        priority: c.optional ? 3 : 2, tier: 2, order: 1.5, reason: `You are ${c.status === 'scheduled' ? 'booked for' : 'studying for'} ${c.code}`, link: { kind: 'career' },
      });
      continue;
    }
    const days = daysBetween(date, c.targetDate);
    if (days > 60) continue;
    out.push({
      key: `cert:${c._id}`,
      area: 'learning',
      title: `Prepare for ${c.code}${c.name ? `: ${c.name}` : ''}`,
      minutes: 45,
      priority: c.optional ? 2 : 1,
      tier: days < 0 ? 0 : 2,
      order: 0,
      reason: days < 0 ? `Certification target passed ${-days} days ago` : `Certification target is in ${days} day${days === 1 ? '' : 's'}`,
      link: { kind: 'career' },
    });
  }

  const phase = [...phases].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).find((p) => p.topics?.some((t) => !t.done) || (p.deliverable && !p.deliverableDone));
  if (phase) {
    const topic = phase.topics?.find((t) => !t.done);
    const title = topic ? topic.title : phase.deliverable;
    const skill = matchSkill(title);
    out.push({
      key: topic ? `topic:${phase._id}:${topic._id}` : `deliverable:${phase._id}`,
      area: 'learning',
      title: topic ? `Study: ${topic.title}` : `Work on: ${phase.deliverable}`,
      minutes: 45,
      priority: 1,
      tier: 2,
      order: skill ? 0.5 : 1,
      reason: `Next step in your career phase "${phase.title}"${skill ? ` (skill priority: ${skill})` : ''}`,
      link: { kind: 'career' },
    });
  }

  if (learn?.session) {
    const s = learn.session;
    out.push({
      key: `learn:${learn.course}:${s.week}-${s.day}`,
      area: 'learning',
      title: s.title,
      minutes: learn.minutes || s.minutes || 60,
      priority: 1,
      tier: 2,
      order: 2,
      reason: `Next session in ${learn.courseTitle || 'your Learn course'}`,
      link: { kind: 'learn', course: learn.course, week: s.week },
    });
  }
  return out.filter((c) => !logged.has(c.key));
}

// Minutes per area, given logs ({ area, minutes }).
export function areaMinutes(logs) {
  const out = Object.fromEntries(AREAS.map((a) => [a, 0]));
  for (const l of logs) if (l.area in out) out[l.area] += l.minutes || 0;
  return out;
}

// How far each area is below its target share (positive = needs time).
export function areaDeficits(minutes, weights) {
  const w = { ...DEFAULT_SETTINGS.weights, ...weights };
  const totalW = AREAS.reduce((n, a) => n + (w[a] || 0), 0) || 1;
  const total = AREAS.reduce((n, a) => n + minutes[a], 0);
  return Object.fromEntries(AREAS.map((a) => [a, (w[a] || 0) / totalW - (total ? minutes[a] / total : 0)]));
}

const reasonFor = (c, deficits) => c.reason || (deficits[c.area] > 0.05 ? `${AREA_LABELS[c.area]} has had the least time this week` : 'Fits your free time');

// Place candidates into windows. Each pick recomputes area balance, so one area can't take the whole day.
export function buildSchedule(windows, candidates, weekMinutes, weights) {
  const free = windows.map((w) => ({ ...w, cursor: w.start }));
  const minutes = { ...weekMinutes };
  const left = [...candidates];
  const scheduled = [];
  const unplaced = [];
  while (left.length) {
    const deficits = areaDeficits(minutes, weights);
    left.sort((a, b) =>
      a.tier - b.tier ||
      deficits[b.area] - deficits[a.area] ||
      (a.priority ?? 2) - (b.priority ?? 2) ||
      (a.order ?? 0) - (b.order ?? 0) ||
      a.title.localeCompare(b.title));
    const c = left.shift();
    const slot = free.find((w) => w.end - w.cursor >= c.minutes);
    if (!slot) {
      unplaced.push({ ...c, reason: reasonFor(c, deficits) });
      continue;
    }
    scheduled.push({ ...c, start: slot.cursor, end: slot.cursor + c.minutes, startTime: toTime(slot.cursor), endTime: toTime(slot.cursor + c.minutes), reason: reasonFor(c, deficits) });
    slot.cursor += c.minutes;
    minutes[c.area] += c.minutes;
  }
  scheduled.sort((a, b) => a.start - b.start);
  return { scheduled, unplaced };
}

// The whole day: free time, schedule and the one thing to do next.
export function planDay({ settings, date, now = 0, busy = [], candidates, weekLogs = [] }) {
  const windows = freeWindows(settings, date, busy, now);
  const weekMinutes = areaMinutes(weekLogs);
  const { scheduled, unplaced } = buildSchedule(windows, candidates, weekMinutes, settings?.weights);
  return {
    date,
    freeMinutes: windows.reduce((n, w) => n + w.minutes, 0),
    windows: windows.map((w) => ({ ...w, startTime: toTime(w.start), endTime: toTime(w.end) })),
    next: scheduled[0] || null,
    scheduled,
    unplaced,
    week: weekMinutes,
  };
}

// ---------- Daily reminder ----------

// Local date and minutes-of-day for an instant in a time zone.
export function localClock(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: validTz(tz), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(instant)).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Send window: from the reminder time for 3 hours, so a late start (server restart, reminder turned
// on in the evening) doesn't send a morning reminder at night. At most once per local day.
export const REMINDER_WINDOW = 180;
export function reminderDue(reminder, instant) {
  if (!reminder?.enabled || !TIME_RE.test(reminder.time || '')) return null;
  const { date, minutes } = localClock(instant, reminder.tz);
  if (reminder.lastSentOn === date) return null;
  const at = toMin(reminder.time);
  return minutes >= at && minutes < at + REMINDER_WINDOW ? { date, minutes } : null;
}

// Short notification text. Only the top item goes through the push service.
export function reminderMessage(plan) {
  const free = plan.freeMinutes >= 60 ? `${Math.floor(plan.freeMinutes / 60)}h${plan.freeMinutes % 60 ? ` ${plan.freeMinutes % 60}m` : ''}` : `${plan.freeMinutes}m`;
  if (!plan.next) return { title: 'Your day', body: plan.freeMinutes ? `${free} free today. Add something to plan.` : 'No free time today.' };
  return { title: `${free} free today`, body: `First up at ${plan.next.startTime}: ${plan.next.title}` };
}
