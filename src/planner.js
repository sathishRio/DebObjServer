import { Router } from 'express';
import { Certification, Phase, Profile } from './models.js';
import { LearnCourse, LearnPref, LearnProgress, LearnSession } from './learnModels.js';
import { PlanDay, PlanItem, PlanLog, PlannerSettings, PushSubscription } from './plannerModels.js';
import {
  addDays, AREAS, careerCandidates, DATE_RE, DEFAULT_SETTINGS, itemCandidates, localDate, planDay, TIME_RE, toMin, validTz,
} from './plannerCore.js';

// Planner API (/api/planner): free time outside office and sleep, and what to do next.
// Mounted behind requireAuth, so Learn-only accounts can't use it. Every query is scoped to req.user.email.
// The browser sends its local `date`, `now` (HH:MM) and `tz`, so days follow the user's clock.

const router = Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, error) => res.status(400).json({ error });

const settingsOut = (doc) => (doc ? { configured: true, ...doc.toJSON() } : { configured: false, ...DEFAULT_SETTINGS, reminder: { enabled: false, time: '07:30', tz: 'UTC', lastSentOn: null } });

// Next unfinished Learn session in the first course (finishing it on the Learn site moves this on).
async function nextLearn(owner) {
  const course = await LearnCourse.findOne().sort({ order: 1, title: 1 }).lean();
  if (!course) return null;
  const doneKeys = new Set(
    (await LearnProgress.find({ owner, course: course.slug, $or: [{ done: true }, { 'combinedWith.week': { $exists: true } }] }, { week: 1, day: 1 }).lean())
      .map((p) => `${p.week}-${p.day}`)
  );
  const sessions = await LearnSession.find({ course: course.slug }, { week: 1, day: 1, title: 1, minutes: 1 }).sort({ week: 1, day: 1 }).lean();
  const session = sessions.find((s) => !doneKeys.has(`${s.week}-${s.day}`));
  if (!session) return null;
  const pref = await LearnPref.findOne({ owner, course: course.slug }).lean();
  return { course: course.slug, courseTitle: course.title, session, minutes: pref?.minutesPerDay || course.minutesPerDay || session.minutes || 60 };
}

// Learn sessions finished in the last 7 local days count as learning time.
async function learnLogs(owner, date, tz) {
  const from = addDays(date, -6);
  const since = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000 * 2); // margin for time zones
  const done = await LearnProgress.find({ owner, done: true, doneAt: { $gte: since } }, { course: 1, week: 1, day: 1, doneAt: 1 }).lean();
  if (!done.length) return [];
  const sessions = await LearnSession.find({ $or: done.map((p) => ({ course: p.course, week: p.week, day: p.day })) }, { course: 1, week: 1, day: 1, minutes: 1 }).lean();
  const mins = Object.fromEntries(sessions.map((s) => [`${s.course}:${s.week}-${s.day}`, s.minutes || 60]));
  return done
    .filter((p) => { const d = localDate(p.doneAt, tz); return d >= from && d <= date; })
    .map((p) => ({ area: 'learning', minutes: mins[`${p.course}:${p.week}-${p.day}`] || 60, ref: `learn:${p.course}:${p.week}-${p.day}` }));
}

function readDay(req, res) {
  const date = req.query.date || req.body?.date;
  if (!DATE_RE.test(date || '')) { bad(res, 'date must be YYYY-MM-DD'); return null; }
  return date;
}

// Today's plan for one user. Also used by the reminder job.
export async function buildToday(owner, date, now, tz) {
  const [settingsDoc, items, todayLogs, day, weekPlanLogs, profile, phases, certifications, learn, learnWeek] = await Promise.all([
    PlannerSettings.findOne({ owner }),
    PlanItem.find({ owner, active: true }).lean(),
    PlanLog.find({ owner, date }).lean(),
    PlanDay.findOne({ owner, date }).lean(),
    PlanLog.find({ owner, status: 'done', date: { $gte: addDays(date, -6), $lte: date } }).lean(),
    Profile.findOne().lean(),
    Phase.find().lean(),
    Certification.find().lean(),
    nextLearn(owner),
    learnLogs(owner, date, tz),
  ]);
  const settings = settingsOut(settingsDoc);
  const logged = new Set(todayLogs.map((l) => l.ref));
  const candidates = [
    ...itemCandidates(items, date, logged),
    ...careerCandidates({ profile, phases, certifications, learn, date, logged }),
  ];
  const plan = planDay({ settings, date, now, busy: day?.busy || [], candidates, weekLogs: [...weekPlanLogs, ...learnWeek] });
  return { configured: settings.configured, tz, ...plan, busy: day?.busy || [], logs: todayLogs.map(({ _id, owner: _o, ...l }) => l) };
}

router.get('/today', ah(async (req, res) => {
  const date = readDay(req, res);
  if (!date) return;
  const now = TIME_RE.test(req.query.now || '') ? toMin(req.query.now) : 0;
  res.json(await buildToday(req.user.email, date, now, validTz(req.query.tz)));
}));

// ---------- Settings ----------

router.get('/settings', ah(async (req, res) => {
  res.json(settingsOut(await PlannerSettings.findOne({ owner: req.user.email })));
}));

router.put('/settings', ah(async (req, res) => {
  const b = req.body || {};
  const doc = (await PlannerSettings.findOne({ owner: req.user.email })) || new PlannerSettings({ owner: req.user.email, ...DEFAULT_SETTINGS });
  if (b.sleep) doc.sleep = b.sleep;
  if (Array.isArray(b.office)) {
    if (b.office.length !== 7) return bad(res, 'office needs 7 days, Monday first');
    for (const o of b.office) if (o && !(TIME_RE.test(o.start) && TIME_RE.test(o.end) && toMin(o.end) > toMin(o.start))) return bad(res, 'Office hours need a start before the end');
    doc.office = b.office.map((o) => (o ? { start: o.start, end: o.end } : null));
  }
  for (const k of ['bufferMinutes', 'minWindow']) if (b[k] !== undefined) doc[k] = Number(b[k]);
  if (b.weights) for (const a of AREAS) if (b.weights[a] !== undefined) doc.weights[a] = Number(b.weights[a]);
  if (b.reminder) {
    for (const k of ['enabled', 'time']) if (b.reminder[k] !== undefined) doc.reminder[k] = b.reminder[k];
    if (b.reminder.tz !== undefined) doc.reminder.tz = validTz(b.reminder.tz);
  }
  await doc.save();
  res.json(settingsOut(doc));
}));

// ---------- Items (health, projects, home, own learning) ----------

const ITEM_FIELDS = ['area', 'title', 'minutes', 'priority', 'dueDate', 'project', 'repeat', 'days', 'active'];
const pick = (body) => Object.fromEntries(ITEM_FIELDS.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));
const opts = { new: true, runValidators: true };

router.get('/items', ah(async (req, res) => {
  res.json(await PlanItem.find({ owner: req.user.email }).sort({ active: -1, area: 1, createdAt: 1 }));
}));

router.post('/items', ah(async (req, res) => {
  res.status(201).json(await PlanItem.create({ ...pick(req.body), owner: req.user.email }));
}));

router.patch('/items/:id', ah(async (req, res) => {
  const item = await PlanItem.findOneAndUpdate({ _id: req.params.id, owner: req.user.email }, pick(req.body), opts);
  return item ? res.json(item) : res.status(404).json({ error: 'Item not found' });
}));

router.delete('/items/:id', ah(async (req, res) => {
  const item = await PlanItem.findOneAndDelete({ _id: req.params.id, owner: req.user.email });
  return item ? res.status(204).end() : res.status(404).json({ error: 'Item not found' });
}));

// ---------- Done / skipped for a day ----------

const REF_RE = /^(item:[0-9a-f]{24}|learn:[\w-]+:\d+-\d+|topic:[0-9a-f]{24}:[0-9a-f]{24}|deliverable:[0-9a-f]{24}|cert:[0-9a-f]{24})$/;

router.post('/log', ah(async (req, res) => {
  const owner = req.user.email;
  const date = readDay(req, res);
  if (!date) return;
  const { ref, status } = req.body || {};
  if (!REF_RE.test(ref || '')) return bad(res, 'Unknown plan item');
  if (!['done', 'skipped'].includes(status)) return bad(res, 'status must be done or skipped');
  let { area, title = '', minutes = 0 } = req.body;
  if (ref.startsWith('item:')) {
    const item = await PlanItem.findOne({ _id: ref.slice(5), owner });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    ({ area, title, minutes } = item);
    // One-off items are finished for good; routines come back on their next day.
    if (status === 'done' && item.repeat === 'none') await PlanItem.updateOne({ _id: item._id }, { completedAt: new Date() });
  } else area = 'learning';
  const log = await PlanLog.findOneAndUpdate(
    { owner, date, ref },
    { $set: { area, title: String(title).slice(0, 200), minutes: status === 'done' ? Number(minutes) || 0 : 0, status } },
    { ...opts, upsert: true }
  );
  res.json(log);
}));

router.delete('/log', ah(async (req, res) => {
  const owner = req.user.email;
  const date = readDay(req, res);
  if (!date) return;
  const ref = req.body?.ref || req.query.ref;
  if (!REF_RE.test(ref || '')) return bad(res, 'Unknown plan item');
  const log = await PlanLog.findOneAndDelete({ owner, date, ref });
  if (log && ref.startsWith('item:')) await PlanItem.updateOne({ _id: ref.slice(5), owner, repeat: 'none' }, { completedAt: null });
  res.status(204).end();
}));

// ---------- One-off busy time ----------

router.put('/day/:date', ah(async (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return bad(res, 'date must be YYYY-MM-DD');
  const busy = Array.isArray(req.body?.busy) ? req.body.busy : [];
  if (busy.length > 20) return bad(res, 'Too many busy blocks');
  for (const b of busy) if (!(TIME_RE.test(b?.start) && TIME_RE.test(b?.end) && toMin(b.end) > toMin(b.start))) return bad(res, 'Busy time needs a start before the end');
  const day = await PlanDay.findOneAndUpdate(
    { owner: req.user.email, date },
    { $set: { busy: busy.map((b) => ({ start: b.start, end: b.end, label: String(b.label || '').slice(0, 100) })) } },
    { ...opts, upsert: true }
  );
  res.json(day);
}));

// ---------- Push reminders ----------
// Imported lazily: plannerReminders imports this file for buildToday.
const reminders = () => import('./plannerReminders.js');

router.get('/push/key', ah(async (_req, res) => {
  const key = (await reminders()).vapidPublicKey();
  return key ? res.json({ publicKey: key }) : res.status(503).json({ error: 'Reminders are not set up on the server yet.' });
}));

router.post('/push/subscribe', ah(async (req, res) => {
  const sub = req.body?.subscription;
  if (!/^https:\/\//.test(sub?.endpoint || '') || !sub?.keys?.p256dh || !sub?.keys?.auth) return bad(res, 'Invalid push subscription');
  // A device belongs to whoever subscribed it last (e.g. after switching accounts).
  await PushSubscription.findOneAndUpdate(
    { endpoint: sub.endpoint },
    { $set: { owner: req.user.email, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: String(req.get('user-agent') || '').slice(0, 200) } },
    { ...opts, upsert: true }
  );
  res.status(204).end();
}));

router.delete('/push/subscribe', ah(async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint === 'string') await PushSubscription.deleteOne({ owner: req.user.email, endpoint });
  res.status(204).end();
}));

router.post('/push/test', ah(async (req, res) => {
  try {
    const r = await (await reminders()).sendToUser(req.user.email, { title: 'Reminders are on', body: 'This is how your daily plan reminder will look.' });
    if (!r.devices) return bad(res, 'No device is subscribed yet.');
    res.json(r);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}));

export default router;
