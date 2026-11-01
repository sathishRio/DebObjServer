import { Router } from 'express';
import { LearningCourse, LearningSettings } from './models.js';
import { issuePurposeToken, issueSyncToken, verifySyncToken } from './auth.js';

// Learning (Coursera) API, web only. Every record is scoped to req.user.email.
// Coursera has no API for personal accounts, so course data arrives from the learner's own browser:
// the sync bookmarklet posts it to POST /api/learning/sync (sync token), or the page imports the
// same JSON through POST /api/learning/import (session).

const router = Router();

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const updateOpts = { new: true, runValidators: true };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const COURSE_FIELDS = ['name', 'partner', 'url', 'phaseId', 'topicId', 'targetDate', 'priority', 'archived'];
const SETTINGS_FIELDS = ['dailyMinutes', 'studyDays'];

const settingsFor = async (owner) =>
  (await LearningSettings.findOne({ owner })) || LearningSettings.create({ owner });

/* ---------- Sync payload ---------- */

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const mins = (v) => Math.min(1440, Math.max(0, Math.round(Number(v) || 0)));

// Keeps only the fields we store, with caps, so a malformed or oversized payload can't get in.
function cleanCourse(c) {
  const modules = (Array.isArray(c?.modules) ? c.modules : []).slice(0, 100).map((m, mi) => ({
    key: str(m?.key, 100) || `m${mi + 1}`,
    name: str(m?.name, 300),
    items: (Array.isArray(m?.items) ? m.items : []).slice(0, 300).map((it, ii) => ({
      key: str(it?.key, 100) || `m${mi + 1}-${ii + 1}`,
      name: str(it?.name, 300),
      type: str(it?.type, 40),
      minutes: mins(it?.minutes),
      optional: !!it?.optional,
      done: it?.done === true ? true : it?.done === false ? false : null, // null = progress unknown
    })),
  }));
  return {
    courseraId: str(c?.courseraId, 100),
    slug: str(c?.slug, 200),
    name: str(c?.name, 300),
    partner: str(c?.partner, 200),
    url: /^https:\/\/www\.coursera\.org\//.test(c?.url || '') ? str(c.url, 500) : '',
    photoUrl: /^https:\/\//.test(c?.photoUrl || '') ? str(c.photoUrl, 500) : '',
    modules,
  };
}

// Upserts synced courses by Coursera id. The app's own fields (phase link, target date, priority)
// are kept, and an item never goes back to not-done: a box ticked in the app may be ahead of Coursera.
async function mergeSync(owner, body) {
  const today = DATE_RE.test(body?.today || '') ? body.today : new Date().toISOString().slice(0, 10);
  const incoming = (Array.isArray(body?.courses) ? body.courses : []).slice(0, 100).map(cleanCourse).filter((c) => c.courseraId && c.name);
  const now = new Date();
  let created = 0, updated = 0, newlyDone = 0;

  for (const c of incoming) {
    const existing = await LearningCourse.findOne({ owner, courseraId: c.courseraId });
    const before = new Map();
    for (const m of existing?.modules || []) for (const it of m.items) before.set(it.key, it);

    const modules = c.modules.map((m) => ({
      ...m,
      items: m.items.map((it) => {
        const prev = before.get(it.key);
        const done = it.done === true || !!prev?.done;
        if (done && !prev?.done) newlyDone++;
        return { ...it, done, doneOn: done ? prev?.doneOn || today : null };
      }),
    }));
    const data = { ...c, modules, source: 'coursera', syncedAt: now };
    if (existing) {
      existing.set(data);
      await existing.save();
      updated++;
    } else {
      await LearningCourse.create({ ...data, owner });
      created++;
    }
  }
  await settingsFor(owner);
  await LearningSettings.updateOne({ owner }, { lastSyncAt: now });
  return { created, updated, newlyDone };
}

// Public route (mounted before requireAuth and the app-wide CORS): the bookmarklet calls it from
// coursera.org with the sync token. Exported separately so index.js can give it its own CORS.
export const syncHandler = ah(async (req, res) => {
  const header = req.get('authorization') || '';
  const owner = verifySyncToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!owner) return res.status(401).json({ error: 'Sync link expired. Copy a new one from the Learning tab.' });
  res.json(await mergeSync(owner, req.body));
});

/* ---------- Page API (signed in) ---------- */

router.get(
  '/',
  ah(async (req, res) => {
    const owner = req.user.email;
    const [settings, courses] = await Promise.all([settingsFor(owner), LearningCourse.find({ owner }).sort({ createdAt: 1 })]);
    res.json({ settings, courses });
  })
);

router.put(
  '/settings',
  ah(async (req, res) => {
    const owner = req.user.email;
    const data = pick(req.body, SETTINGS_FIELDS);
    if (data.studyDays) data.studyDays = [...new Set(data.studyDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    await settingsFor(owner);
    res.json(await LearningSettings.findOneAndUpdate({ owner }, data, updateOpts));
  })
);

router.get('/sync-token', (req, res) => res.json({ token: issueSyncToken(req.user.email) }));
// Key for the Chrome notes extension: it can only read and write learning notes.
router.get('/notes-token', (req, res) => res.json({ token: issuePurposeToken(req.user.email, 'learning-notes') }));

router.post('/import', ah(async (req, res) => res.json(await mergeSync(req.user.email, req.body))));

// Manual course: the page sends the module count and total hours; we split them into even items
// so it plans exactly like a synced course.
router.post(
  '/courses',
  ah(async (req, res) => {
    const moduleCount = Math.min(50, Math.max(1, Math.round(Number(req.body.moduleCount) || 1)));
    const perModule = Math.max(5, Math.round((Number(req.body.totalHours) || 1) * 60 / moduleCount));
    const modules = Array.from({ length: moduleCount }, (_, i) => ({
      key: `m${i + 1}`,
      name: `Module ${i + 1}`,
      items: [{ key: `m${i + 1}-1`, name: `Module ${i + 1}`, type: 'module', minutes: perModule }],
    }));
    const course = await LearningCourse.create({ ...pick(req.body, COURSE_FIELDS), modules, source: 'manual', owner: req.user.email });
    res.status(201).json(course);
  })
);

router.put(
  '/courses/:id',
  ah(async (req, res) => {
    const course = await LearningCourse.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.email },
      pick(req.body, COURSE_FIELDS),
      updateOpts
    );
    return course ? res.json(course) : res.status(404).json({ error: 'Course not found' });
  })
);

router.delete(
  '/courses/:id',
  ah(async (req, res) => {
    const course = await LearningCourse.findOneAndDelete({ _id: req.params.id, owner: req.user.email });
    return course ? res.status(204).end() : res.status(404).json({ error: 'Course not found' });
  })
);

// Tick an item off in the app. `today` is the browser's local date, used for the daily minutes.
router.put(
  '/courses/:id/items/:key',
  ah(async (req, res) => {
    const course = await LearningCourse.findOne({ _id: req.params.id, owner: req.user.email });
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const item = course.modules.flatMap((m) => m.items).find((it) => it.key === req.params.key);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const done = !!req.body.done;
    item.done = done;
    item.doneOn = done ? (DATE_RE.test(req.body.today || '') ? req.body.today : new Date().toISOString().slice(0, 10)) : null;
    await course.save();
    res.json(course);
  })
);

export default router;
