import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import { Task } from './models.js';
import { syncObjective } from './routes.js';
import { PlannerSettings, PushDevice, PushSubscription } from './plannerModels.js';
import { localClock } from './plannerCore.js';
import { armKey, parseMinutes, planKey, planNotice, taskNotices, utcMsOf } from './notifyCore.js';
import { buildToday, logPlan } from './planner.js';
import { pushConfigured, pushStatus, sendToUser } from './plannerReminders.js';

// Notifications built from tasks every minute: kept as an inbox (web #/notifications) and pushed
// to the user's phones (FCM) and browsers (Web Push) when push is configured. Alerts repeat every
// 15 minutes until the task is done or skipped (see notifyCore.js); snooze sets the next one.
// Hub "Today" plan items alert the same way while they are scheduled in free time right now.

const { Schema, model } = mongoose;
const hide = {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    delete ret.owner;
    return ret;
  },
};

// One inbox entry per main task (key alert:<id>), refreshed on each repeat; one per morning summary.
const notificationSchema = new Schema(
  {
    owner: { type: String, required: true, index: true },
    key: { type: String, required: true, maxlength: 300 },
    kind: { type: String, enum: ['reminder', 'due_soon', 'digest', 'overdue', 'plan'], required: true },
    title: { type: String, required: true, maxlength: 300 },
    body: { type: String, default: '', maxlength: 1000 },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    taskIds: [{ type: Schema.Types.ObjectId, ref: 'Task' }],
    url: { type: String, default: '/#/tasks' },
    readAt: { type: Date, default: null },
    sentAt: { type: Date, default: Date.now },
    repeats: { type: Number, default: 0 },
    snoozedUntil: { type: Date, default: null },
    skipped: { type: Boolean, default: false },
    done: { type: Boolean, default: false }, // plan item marked done here
    pushed: { type: Number, default: 0 }, // devices the last send reached
    // Hub plan item (kind 'plan'): enough to mark it done or skipped.
    plan: { type: new Schema({ date: String, ref: String, area: String, title: String, minutes: Number }, { _id: false }), default: null },
  },
  { timestamps: true }
);
notificationSchema.index({ owner: 1, key: 1 }, { unique: true });
notificationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 }); // kept 60 days
notificationSchema.set('toJSON', hide);
export const Notification = model('Notification', notificationSchema);

// Alert state per user and thing: `ref` is a task id, or plan:<date>:<plan ref> for a Hub plan item.
const alertStateSchema = new Schema({
  owner: { type: String, required: true },
  ref: { type: String, required: true },
  armKey: { type: String, required: true },
  lastSentAt: { type: Date, default: null },
  snoozeUntil: { type: Date, default: null },
  skipped: { type: Boolean, default: false },
});
alertStateSchema.index({ owner: 1, ref: 1 }, { unique: true });
export const AlertState = model('AlertState', alertStateSchema);
// Alert-state refs a notification covers: its tasks, or its plan item.
const refsOf = (n) => (n.plan ? [n.key] : n.taskIds.map(String));

const EVERY = 60 * 1000;
const owners = () => (process.env.ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
// The user's time zone comes from their planner settings; NOTIFY_TZ is the fallback.
async function tzOf(owner) {
  const s = await PlannerSettings.findOne({ owner }, 'reminder.tz').lean();
  const tz = s?.reminder?.tz;
  return tz && tz !== 'UTC' ? tz : process.env.NOTIFY_TZ || 'UTC';
}

// Phone buttons act without the user's session: each push carries a signature that allows Done,
// Skip or Remind me on that one notification only.
const sign = (id) => createHmac('sha256', process.env.JWT_SECRET || 'dev').update(`notify:${id}`).digest('base64url');
const validSig = (id, sig) => {
  const a = Buffer.from(sign(id));
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

async function push(owner, doc, n, tz) {
  if (!pushConfigured()) return;
  try {
    // Alerts get the phone buttons and a timer: to the due time (or from it, when overdue) or the plan slot's end.
    const at = n.ends || n.due;
    const alert = n.key.startsWith('digest:') ? undefined : {
      id: String(doc._id), sig: sign(doc._id), kind: n.kind,
      ...(at?.time ? { [n.ends ? 'endsAt' : 'dueAt']: utcMsOf(at.date, at.time, tz) } : {}),
    };
    const r = await sendToUser(owner, { title: n.title, body: n.body, url: n.url, alert });
    await Notification.updateOne({ _id: doc._id }, { pushed: r.sent });
  } catch (e) {
    console.warn(`Notification push to ${owner} failed: ${e.message}`);
  }
}

let running = false;
export async function runNotifications(now = new Date()) {
  if (running) return; // a slow run is never overlapped
  running = true;
  try {
    const tasks = await Task.find({ status: { $ne: 'done' }, dueDate: { $ne: null } }).lean();
    const parentIds = [...new Set(tasks.filter((t) => t.parentId).map((t) => String(t.parentId)))];
    const parents = await Task.find({ _id: { $in: parentIds } }, 'title').lean();
    const titles = Object.fromEntries([...tasks, ...parents].map((t) => [String(t._id), t.title]));

    for (const owner of owners()) {
      const rows = await AlertState.find({ owner, ref: { $in: tasks.map((t) => String(t._id)) } }).lean();
      const states = Object.fromEntries(rows.map((s) => [s.ref, {
        armKey: s.armKey, skipped: s.skipped, lastSentAt: s.lastSentAt?.getTime(), snoozeUntil: s.snoozeUntil?.getTime(),
      }]));
      const tz = await tzOf(owner);
      const clock = localClock(now, tz);
      const { alerts, digest } = taskNotices(tasks, clock, { nowMs: now.getTime(), states, titles });
      const planAlert = await planAlertFor(owner, clock, now);
      if (planAlert) alerts.push(planAlert);

      if (digest) {
        try {
          const doc = await Notification.create({ owner, ...digest, sentAt: now }); // unique key: once a day
          await push(owner, doc, digest, tz);
        } catch (e) {
          if (e.code !== 11000) throw e;
        }
      }

      for (const n of alerts) {
        const { repeat, due: _due, ends: _ends, ...fields } = n;
        // Mark sent first, so a crash can't make it repeat early.
        const byId = Object.fromEntries(tasks.map((t) => [String(t._id), t]));
        const refs = n.plan ? [n.key] : n.taskIds;
        await AlertState.bulkWrite(refs.map((ref) => ({
          updateOne: {
            filter: { owner, ref },
            update: { $set: { armKey: n.plan ? n.key : armKey(byId[ref]), lastSentAt: now, snoozeUntil: null, skipped: false } },
            upsert: true,
          },
        })));
        const doc = await Notification.findOneAndUpdate(
          { owner, key: n.key },
          { $set: { ...fields, readAt: null, sentAt: now, snoozedUntil: null, skipped: false }, $inc: { repeats: repeat ? 1 : 0 } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await push(owner, doc, n, tz);
      }
    }
  } finally {
    running = false;
  }
}

// The Hub plan item scheduled right now, if the user has set up the planner.
async function planAlertFor(owner, clock, now) {
  try {
    const plan = await buildToday(owner, clock.date, clock.minutes, await tzOf(owner));
    if (!plan.configured || !plan.next) return null;
    const s = await AlertState.findOne({ owner, ref: planKey(clock.date, plan.next.ref) }).lean();
    const state = s && { armKey: s.armKey, skipped: s.skipped, lastSentAt: s.lastSentAt?.getTime(), snoozeUntil: s.snoozeUntil?.getTime() };
    return planNotice(plan, clock, now.getTime(), state);
  } catch (e) {
    console.warn(`Plan alert for ${owner} failed: ${e.message}`);
    return null;
  }
}

export function startNotifications() {
  // The first version keyed alert state by taskId; that unique index would now clash.
  AlertState.collection.dropIndex('owner_1_taskId_1').catch(() => {});
  const tick = () => runNotifications().catch((e) => console.warn(`Notification run failed: ${e.message}`));
  setTimeout(tick, 20 * 1000);
  setInterval(tick, EVERY);
  console.log(`Task notifications: checking every minute${pushConfigured() ? ', with push' : ' (inbox only, push not configured)'}.`);
}

/* ---------- Done / Skip / Snooze, shared by the inbox and the phone buttons ---------- */

async function snooze(n, minutes) {
  const until = new Date(Date.now() + minutes * 60000);
  await AlertState.updateMany({ owner: n.owner, ref: { $in: refsOf(n) } }, { snoozeUntil: until });
  n.set({ snoozedUntil: until, readAt: new Date() });
  return n.save();
}

// Tasks: until they get a new due date or time. A plan item: skipped for the day in Hub.
async function skip(n) {
  if (n.plan) await logPlan(n.owner, n.plan.date, n.plan.ref, 'skipped', n.plan);
  await AlertState.updateMany({ owner: n.owner, ref: { $in: refsOf(n) } }, { skipped: true });
  n.set({ skipped: true, snoozedUntil: null, readAt: new Date() });
  return n.save();
}

// A plan item: done for the day in Hub. Tasks: marked done (their main task follows, as in the app).
async function done(n) {
  if (n.plan) {
    await logPlan(n.owner, n.plan.date, n.plan.ref, 'done', n.plan);
  } else {
    const open = await Task.find({ _id: { $in: n.taskIds }, status: { $ne: 'done' } });
    for (const t of open) {
      t.set({ status: 'done', completedAt: new Date() });
      await t.save();
    }
    const parents = new Set(open.map((t) => t.parentId && String(t.parentId)).filter(Boolean));
    for (const parentId of parents) await syncObjective(parentId);
  }
  await AlertState.updateMany({ owner: n.owner, ref: { $in: refsOf(n) } }, { skipped: true });
  n.set({ readAt: new Date(), done: true, snoozedUntil: null });
  return n.save();
}

// POST /api/notifications/:id/action { sig, action: done|skip|snooze, minutes: "20" | "1h" | "" }
// Public (no session): the phone calls it from a notification button. The signature is the key.
export const actionHandler = async (req, res, next) => {
  try {
    const { sig, action, minutes } = req.body || {};
    if (!/^[0-9a-f]{24}$/.test(req.params.id) || !validSig(req.params.id, sig)) return res.status(403).json({ error: 'Not allowed' });
    const n = await Notification.findById(req.params.id);
    if (!n) return res.status(404).json({ error: 'Notification not found' });
    if (action === 'done') await done(n);
    else if (action === 'skip') await skip(n);
    else if (action === 'snooze') {
      const parsed = parseMinutes(minutes);
      const m = parsed ?? 15;
      await snooze(n, m);
      return res.json({ ok: true, minutes: m, understood: parsed !== null, next: new Date(Date.now() + m * 60000) });
    } else return res.status(400).json({ error: 'action must be done, skip or snooze' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
};

/* ---------- Routes: /api/notifications ---------- */

const router = Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const mine = (req) => Notification.findOne({ _id: req.params.id, owner: req.user.email });
const notFound = (res) => res.status(404).json({ error: 'Notification not found' });

router.get('/', ah(async (req, res) => {
  const owner = req.user.email;
  const [items, unread] = await Promise.all([
    Notification.find({ owner }).sort({ sentAt: -1 }).limit(100),
    Notification.countDocuments({ owner, readAt: null }),
  ]);
  res.json({ items, unread });
}));

/* ---------- Push test screen (hub #/push-test) ---------- */

// "Chrome on Windows" from a user agent, for the device list.
function browserLabel(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
const tail = (s) => String(s).slice(-12); // lets a device spot itself without the server sending whole tokens
const isId = (s) => /^[0-9a-f]{24}$/.test(String(s || ''));

// Kinds to try: a plain notification, or an alert with Done / Skip / Remind me (and a timer for timed kinds).
const TEST_KINDS = {
  plain: { kind: 'digest', title: 'Test notification', body: 'Plain notification, no buttons.' },
  reminder: { kind: 'reminder', title: 'Test reminder', body: 'Try Done, Skip or Remind me.' },
  due_soon: { kind: 'due_soon', title: 'Test: due in 10 minutes', body: 'Shows a timer counting down to the due time.', dueIn: 10 },
  overdue: { kind: 'overdue', title: 'Test: overdue', body: 'Shows how long ago it was due.', dueIn: -5 },
  plan: { kind: 'plan', title: 'Test: plan item now', body: 'Free-time item, ends in 30 minutes.', endsIn: 30 },
};
// Send results by notification id, for the screen to read back after a delayed send. Lost on restart; that's fine.
const testRuns = new Map();
const keepRun = (id, run) => {
  testRuns.set(id, run);
  if (testRuns.size > 50) testRuns.delete(testRuns.keys().next().value);
};

router.get('/test/status', ah(async (req, res) => {
  const owner = req.user.email;
  const [subs, devices] = await Promise.all([
    PushSubscription.find({ owner }).sort({ updatedAt: -1 }).lean(),
    PushDevice.find({ owner }).sort({ updatedAt: -1 }).lean(),
  ]);
  res.json({
    ...pushStatus(),
    devices: [
      ...devices.map((d) => ({ id: String(d._id), type: d.platform, label: d.platform === 'ios' ? 'iPhone / iPad app' : 'Android app', tail: tail(d.token), since: d.createdAt, seen: d.updatedAt })),
      ...subs.map((s) => ({ id: String(s._id), type: 'web', label: browserLabel(s.device), tail: tail(s.endpoint), since: s.createdAt, seen: s.updatedAt })),
    ],
  });
}));

// POST { kind, deviceId? (one device; all when empty), title?, body?, delay? (seconds, 0–300) }
router.post('/test', ah(async (req, res) => {
  const owner = req.user.email;
  const { kind = 'reminder', deviceId, title, body } = req.body || {};
  const t = TEST_KINDS[kind];
  if (!t) return res.status(400).json({ error: `kind must be one of ${Object.keys(TEST_KINDS).join(', ')}` });
  if (deviceId && !isId(deviceId)) return res.status(400).json({ error: 'Invalid device' });
  const delay = Math.max(0, Math.min(300, Math.round(Number(req.body?.delay) || 0)));
  const { web, app } = pushStatus();
  if (!web && !app) return res.status(503).json({ error: 'Push is not set up on the server (VAPID keys or FIREBASE_SERVICE_ACCOUNT).' });

  const now = Date.now();
  const n = {
    key: `test:${now}`, kind: t.kind, url: '/#/push-test',
    title: String(title || t.title).slice(0, 300), body: String(body ?? t.body).slice(0, 1000),
  };
  const doc = await Notification.create({ owner, ...n, sentAt: new Date(now + delay * 1000) });
  const id = String(doc._id);
  const alert = kind === 'plain' ? undefined : {
    id, sig: sign(id), kind: t.kind,
    ...(t.dueIn != null ? { dueAt: now + (delay + t.dueIn * 60) * 1000 } : {}),
    ...(t.endsIn != null ? { endsAt: now + (delay + t.endsIn * 60) * 1000 } : {}),
  };
  const send = async () => {
    try {
      const r = await sendToUser(owner, { title: n.title, body: n.body, url: n.url, alert }, { only: deviceId || undefined });
      await Notification.updateOne({ _id: doc._id }, { pushed: r.sent });
      keepRun(id, { state: 'sent', sent: r.sent, devices: r.devices, results: r.results });
    } catch (e) {
      keepRun(id, { state: 'failed', error: e.message, results: [] });
    }
  };
  if (delay) {
    keepRun(id, { state: 'waiting', sendAt: now + delay * 1000, results: [] });
    setTimeout(send, delay * 1000);
  } else await send();
  res.json({ id, ...testRuns.get(id) });
}));

// The send results and what was pressed on the phone (Done / Skip / Remind me).
router.get('/test/:id', ah(async (req, res) => {
  if (!isId(req.params.id)) return notFound(res);
  const n = await Notification.findOne({ _id: req.params.id, owner: req.user.email }).lean();
  if (!n) return notFound(res);
  res.json({
    id: req.params.id,
    ...(testRuns.get(req.params.id) || { state: 'unknown', results: [] }),
    pressed: n.done ? 'done' : n.skipped ? 'skip' : n.snoozedUntil ? 'snooze' : null,
    snoozedUntil: n.snoozedUntil,
  });
}));

// Drop a stale device or browser from this account.
router.delete('/test/devices/:id', ah(async (req, res) => {
  if (!isId(req.params.id)) return res.status(204).end();
  await Promise.all([
    PushDevice.deleteOne({ _id: req.params.id, owner: req.user.email }),
    PushSubscription.deleteOne({ _id: req.params.id, owner: req.user.email }),
  ]);
  res.status(204).end();
}));

router.get('/unread', ah(async (req, res) => res.json({ unread: await Notification.countDocuments({ owner: req.user.email, readAt: null }) })));

router.post('/read-all', ah(async (req, res) => {
  await Notification.updateMany({ owner: req.user.email, readAt: null }, { readAt: new Date() });
  res.status(204).end();
}));

router.post('/:id/read', ah(async (req, res) => {
  const n = await Notification.findOneAndUpdate({ _id: req.params.id, owner: req.user.email }, { readAt: new Date() }, { new: true });
  return n ? res.json(n) : notFound(res);
}));

// Next alert in `minutes` (1 to 1440) instead of the usual 15.
router.post('/:id/snooze', ah(async (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return res.status(400).json({ error: 'Snooze for 1 to 1440 minutes' });
  const n = await mine(req);
  return n ? res.json(await snooze(n, minutes)) : notFound(res);
}));

router.post('/:id/skip', ah(async (req, res) => {
  const n = await mine(req);
  return n ? res.json(await skip(n)) : notFound(res);
}));

// Plan items only here: the web app marks tasks done through /tasks, so its store stays in sync.
router.post('/:id/done', ah(async (req, res) => {
  const n = await mine(req);
  if (!n) return notFound(res);
  if (!n.plan) return res.status(400).json({ error: 'Mark tasks done on the task' });
  res.json(await done(n));
}));

router.delete('/', ah(async (req, res) => {
  await Notification.deleteMany({ owner: req.user.email, readAt: { $ne: null } }); // clear read ones
  res.status(204).end();
}));

router.delete('/:id', ah(async (req, res) => {
  await Notification.deleteOne({ _id: req.params.id, owner: req.user.email });
  res.status(204).end();
}));

export default router;
