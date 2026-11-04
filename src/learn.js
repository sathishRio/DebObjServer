import { Router } from 'express';
import { LearnCourse, LearnMilestone, LearnPref, LearnProgress, LearnSession, LearnStage, LearnWeek } from './learnModels.js';

// Learn site API (/api/learn). Course content is shared; progress and milestones are scoped to req.user.email.

const router = Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const courseOr404 = async (req, res) => {
  const course = await LearnCourse.findOne({ slug: req.params.course }).lean();
  if (!course) res.status(404).json({ error: 'Course not found' });
  return course;
};

const intParam = (v) => (/^\d+$/.test(String(v)) ? Number(v) : NaN);
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

// Consecutive days (ending today or yesterday) with at least one session done.
function streakOf(doneDates) {
  const days = new Set(doneDates.map(ymd));
  const cursor = new Date();
  if (!days.has(ymd(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let n = 0;
  while (days.has(ymd(cursor))) {
    n += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return n;
}

async function summaryFor(owner, course) {
  const [all, done] = await Promise.all([
    LearnSession.find({ course: course.slug }, { week: 1, day: 1, stage: 1 }).lean(),
    LearnProgress.find({ owner, course: course.slug, done: true }, { week: 1, day: 1, doneAt: 1 }).lean(),
  ]);
  const total = all.length;
  const stageOf = Object.fromEntries(all.map((s) => [`${s.week}-${s.day}`, s.stage]));
  const perWeek = {};
  const perStage = {};
  const weekSize = {};
  const stageSize = {};
  for (const s of all) {
    weekSize[s.week] = (weekSize[s.week] || 0) + 1;
    stageSize[s.stage] = (stageSize[s.stage] || 0) + 1;
  }
  for (const p of done) {
    perWeek[p.week] = (perWeek[p.week] || 0) + 1;
    const st = stageOf[`${p.week}-${p.day}`];
    if (st) perStage[st] = (perStage[st] || 0) + 1;
  }
  return {
    total,
    done: done.length,
    percent: total ? Math.round((done.length / total) * 100) : 0,
    streak: streakOf(done.filter((p) => p.doneAt).map((p) => p.doneAt)),
    perWeek,
    weekSize, // sessions in each week
    perStage,
    stageSize,
  };
}

const sessionOut = (s, p) => ({
  week: s.week,
  day: s.day,
  dayName: DAYS[s.day],
  dayNo: s.dayNo ?? null,
  stage: s.stage,
  type: s.type || 'study',
  title: s.title || '',
  goal: s.goal || '',
  minutes: s.minutes || null,
  milestone: !!s.milestone,
  intro: s.intro || '',
  sections: s.sections || [],
  done: !!p?.done,
  doneAt: p?.doneAt || null,
  notes: p?.notes || '',
  blocks: blocksOf(p, checkCount(s)),
  combinedWith: p?.combinedWith?.week ? { ...p.combinedWith, dayName: DAYS[p.combinedWith.day] } : null,
});

// Sessions pulled into host (week, day), in course order, shaped for the client.
async function combinedInto(owner, slug, week, day) {
  const kids = await LearnProgress.find({ owner, course: slug, 'combinedWith.week': week, 'combinedWith.day': day }).lean();
  if (!kids.length) return [];
  const sessions = await LearnSession.find({ course: slug, $or: kids.map((k) => ({ week: k.week, day: k.day })) }).sort({ week: 1, day: 1 }).lean();
  const byKey = Object.fromEntries(kids.map((k) => [`${k.week}-${k.day}`, k]));
  return sessions.map((x) => sessionOut(x, byKey[`${x.week}-${x.day}`]));
}

// One check per block of the session (e.g. Learn / Exercise / Wrap-up).
const checkCount = (s) => s?.sections?.length || 1;

function blocksOf(p, n = 3) {
  const b = p?.blocks || [];
  return Array.from({ length: n }, (_, i) => !!p?.done || !!b[i]);
}

const minutesFor = async (owner, course) =>
  (await LearnPref.findOne({ owner, course: course.slug }).lean())?.minutesPerDay || course.minutesPerDay || 60;

// Courses with this user's progress.
router.get('/courses', ah(async (req, res) => {
  const courses = await LearnCourse.find().sort({ order: 1, title: 1 }).lean();
  res.json(await Promise.all(courses.map(async (c) => ({ ...c, summary: await summaryFor(req.user.email, c) }))));
}));

router.get('/courses/:course', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const [stages, weeks, summary] = await Promise.all([
    LearnStage.find({ course: course.slug }).sort({ n: 1 }).lean(),
    LearnWeek.find({ course: course.slug }).sort({ week: 1 }).lean(),
    summaryFor(req.user.email, course),
  ]);
  res.json({ ...course, stages, weeks, summary });
}));

// Next unfinished session (in course order), with its week and stage.
router.get('/courses/:course/today', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const owner = req.user.email;
  // Skip finished sessions and ones pulled into an earlier day.
  const doneKeys = new Set(
    (await LearnProgress.find(
      { owner, course: course.slug, $or: [{ done: true }, { 'combinedWith.week': { $exists: true } }] },
      { week: 1, day: 1 }
    ).lean()).map((p) => `${p.week}-${p.day}`)
  );
  const sessions = await LearnSession.find({ course: course.slug }, { week: 1, day: 1 }).sort({ week: 1, day: 1 }).lean();
  const next = sessions.find((s) => !doneKeys.has(`${s.week}-${s.day}`));
  if (!next) return res.json({ finished: true, summary: await summaryFor(owner, course) });
  const [s, p, week] = await Promise.all([
    LearnSession.findOne({ course: course.slug, week: next.week, day: next.day }).lean(),
    LearnProgress.findOne({ owner, course: course.slug, week: next.week, day: next.day }).lean(),
    LearnWeek.findOne({ course: course.slug, week: next.week }).lean(),
  ]);
  const stage = await LearnStage.findOne({ course: course.slug, n: s.stage ?? week?.stage }).lean();
  const session = { ...sessionOut(s, p), combined: await combinedInto(owner, course.slug, s.week, s.day) };
  res.json({ finished: false, session, week, stage, minutesPerDay: await minutesFor(owner, course), summary: await summaryFor(owner, course) });
}));

router.get('/courses/:course/weeks/:week', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const n = intParam(req.params.week);
  const week = await LearnWeek.findOne({ course: course.slug, week: n }).lean();
  if (!week) return res.status(404).json({ error: 'Week not found' });
  const [sessions, progress, stage] = await Promise.all([
    LearnSession.find({ course: course.slug, week: n }).sort({ day: 1 }).lean(),
    LearnProgress.find({ owner: req.user.email, course: course.slug, week: n }).lean(),
    LearnStage.findOne({ course: course.slug, n: week.stage }).lean(),
  ]);
  const byDay = Object.fromEntries(progress.map((p) => [p.day, p]));
  const out = await Promise.all(sessions.map(async (s) => ({
    ...sessionOut(s, byDay[s.day]),
    combined: await combinedInto(req.user.email, course.slug, s.week, s.day),
  })));
  res.json({ ...week, stageInfo: stage, totalWeeks: course.totalWeeks, sessions: out });
}));

// Mark done/undone and/or save notes for one session.
router.put('/courses/:course/progress/:week/:day', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const week = intParam(req.params.week);
  const day = intParam(req.params.day);
  const session = await LearnSession.findOne({ course: course.slug, week, day }, { sections: 1 }).lean();
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const n = checkCount(session);
  const { done, notes, blocks } = req.body || {};
  const set = {};
  if (Array.isArray(blocks) && blocks.length === n && blocks.every((b) => typeof b === 'boolean')) {
    set.blocks = blocks;
    const all = blocks.every(Boolean);
    set.done = all;
    set.doneAt = all ? new Date() : null;
  } else if (typeof done === 'boolean') {
    set.done = done;
    set.doneAt = done ? new Date() : null;
    set.blocks = Array(n).fill(done);
  }
  if (typeof notes === 'string') set.notes = notes.slice(0, 20000);
  const p = await LearnProgress.findOneAndUpdate(
    { owner: req.user.email, course: course.slug, week, day },
    { $set: set },
    { new: true, upsert: true, runValidators: true }
  ).lean();
  // Topics combined into this day finish (or reopen) with it.
  if ('done' in set) {
    await LearnProgress.updateMany(
      { owner: req.user.email, course: course.slug, 'combinedWith.week': week, 'combinedWith.day': day },
      { $set: { done: set.done, doneAt: set.doneAt, blocks: [] } }
    );
  }
  res.json({ done: p.done, doneAt: p.doneAt || null, notes: p.notes, blocks: blocksOf(p, n), summary: await summaryFor(req.user.email, course) });
}));

router.get('/courses/:course/progress', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const [summary, stages, ms] = await Promise.all([
    summaryFor(req.user.email, course),
    LearnStage.find({ course: course.slug }).sort({ n: 1 }).lean(),
    LearnMilestone.find({ owner: req.user.email, course: course.slug }).lean(),
  ]);
  const doneBy = Object.fromEntries(ms.map((m) => [m.stage, m]));
  res.json({
    summary,
    totalWeeks: course.totalWeeks,
    milestones: stages.map((s) => ({ stage: s.n, title: s.title, label: s.milestone, done: !!doneBy[s.n]?.done })),
  });
}));

router.put('/courses/:course/milestones/:stage', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const stage = intParam(req.params.stage);
  if (!(await LearnStage.exists({ course: course.slug, n: stage }))) return res.status(404).json({ error: 'Stage not found' });
  const done = req.body?.done === true;
  await LearnMilestone.updateOne(
    { owner: req.user.email, course: course.slug, stage },
    { $set: { done, doneAt: done ? new Date() : null } },
    { upsert: true }
  );
  res.json({ stage, done });
}));

// Combine: pull the next open topic into this day (everything after shifts one day earlier).
router.post('/courses/:course/progress/:week/:day/combine', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const owner = req.user.email;
  const week = intParam(req.params.week);
  const day = intParam(req.params.day);
  const [sessions, progress] = await Promise.all([
    LearnSession.find({ course: course.slug }, { week: 1, day: 1 }).sort({ week: 1, day: 1 }).lean(),
    LearnProgress.find({ owner, course: course.slug }).lean(),
  ]);
  const byKey = Object.fromEntries(progress.map((p) => [`${p.week}-${p.day}`, p]));
  const host = byKey[`${week}-${day}`];
  const at = sessions.findIndex((s) => s.week === week && s.day === day);
  if (at < 0) return res.status(404).json({ error: 'Session not found' });
  if (host?.combinedWith?.week) return res.status(400).json({ error: 'This topic is already combined into another day' });
  const next = sessions.slice(at + 1).find((s) => {
    const p = byKey[`${s.week}-${s.day}`];
    return !p?.done && !p?.combinedWith?.week;
  });
  if (!next) return res.status(400).json({ error: 'No later topic left to combine' });
  await LearnProgress.findOneAndUpdate(
    { owner, course: course.slug, week: next.week, day: next.day },
    { $set: { combinedWith: { week, day }, done: !!host?.done, doneAt: host?.done ? new Date() : null } },
    { upsert: true }
  );
  res.json({ combined: await combinedInto(owner, course.slug, week, day), summary: await summaryFor(owner, course) });
}));

// Split: give every topic combined into this day its own day again.
router.delete('/courses/:course/progress/:week/:day/combine', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const owner = req.user.email;
  const week = intParam(req.params.week);
  const day = intParam(req.params.day);
  await LearnProgress.updateMany(
    { owner, course: course.slug, 'combinedWith.week': week, 'combinedWith.day': day },
    { $unset: { combinedWith: 1 } }
  );
  res.json({ combined: [], summary: await summaryFor(owner, course) });
}));

// The whole plan at a glance: every session with this learner's done state, plus where they are now.
// Used for maps (line map, week strips, the 3D city).
router.get('/courses/:course/map', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const owner = req.user.email;
  const [stages, weeks, sessions, progress] = await Promise.all([
    LearnStage.find({ course: course.slug }, { _id: 0, course: 0 }).sort({ n: 1 }).lean(),
    LearnWeek.find({ course: course.slug }, { _id: 0, week: 1, stage: 1, title: 1 }).sort({ week: 1 }).lean(),
    LearnSession.find({ course: course.slug }, { _id: 0, week: 1, day: 1, dayNo: 1, stage: 1, type: 1, title: 1, milestone: 1 }).sort({ week: 1, day: 1 }).lean(),
    LearnProgress.find({ owner, course: course.slug }, { week: 1, day: 1, done: 1, combinedWith: 1 }).lean(),
  ]);
  const byKey = Object.fromEntries(progress.map((p) => [`${p.week}-${p.day}`, p]));
  const out = sessions.map((x) => {
    const p = byKey[`${x.week}-${x.day}`];
    return { ...x, dayName: DAYS[x.day], done: !!p?.done, combined: !!p?.combinedWith?.week };
  });
  const next = out.find((x) => !x.done && !x.combined);
  res.json({
    slug: course.slug,
    title: course.title,
    stages,
    weeks,
    sessions: out,
    current: next ? { week: next.week, day: next.day } : null,
    summary: await summaryFor(owner, course),
  });
}));

// This learner's settings for a course (minutes per day; course default when unset).
router.get('/courses/:course/settings', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  res.json({ minutesPerDay: await minutesFor(req.user.email, course), defaultMinutes: course.minutesPerDay || 60 });
}));

router.put('/courses/:course/settings', ah(async (req, res) => {
  const course = await courseOr404(req, res);
  if (!course) return;
  const m = Number(req.body?.minutesPerDay);
  if (!Number.isInteger(m) || m < 15 || m > 600) return res.status(400).json({ error: 'Minutes per day must be a whole number from 15 to 600' });
  await LearnPref.updateOne({ owner: req.user.email, course: course.slug }, { $set: { minutesPerDay: m } }, { upsert: true });
  res.json({ minutesPerDay: m });
}));

export default router;
