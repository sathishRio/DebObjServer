import { Router } from 'express';
import mongoose from 'mongoose';
import { DATE_RE, normalizePlan, PlanError, resolveDay, summarize, versionFor } from './fitnessCore.js';

// Fitness tracker (/api/fitness). Mounted behind requireAuth; every query is scoped to req.user.email.
//
// FitnessPlan: the user's central plan (workouts, diet, phases, weekly targets). Saving creates a
//   version effective from a date (default: the user's today), so upcoming days follow the edit and
//   past days keep the plan they were done with. Saving twice on one day replaces that day's version.
// FitnessLog: what happened on a date (weight, ticks, weights lifted). It never copies the plan.

const { Schema, model } = mongoose;
const smallJson = (max) => ({ validator: (v) => v == null || JSON.stringify(v).length <= max, message: 'Too much data' });

const planSchema = new Schema({
  owner: { type: String, required: true },
  effectiveFrom: { type: String, required: true, match: DATE_RE },
  plan: { type: Schema.Types.Mixed, required: true, validate: smallJson(300_000) },
}, { timestamps: true, minimize: false });
planSchema.index({ owner: 1, effectiveFrom: 1 }, { unique: true });

const num = (min, max) => ({ type: Number, min, max, default: null });
const logSchema = new Schema({
  owner: { type: String, required: true },
  date: { type: String, required: true, match: DATE_RE },
  weight: num(20, 400),
  waist: num(30, 300),
  water: { type: Number, min: 0, max: 20000, default: 0 }, // ml
  steps: num(0, 200000),
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  workoutDone: { type: Boolean, default: false },
  minutes: num(0, 600),
  // { "<exercise name>": { done, sets: [{ kg, reps }] } }
  exercises: { type: Schema.Types.Mixed, default: () => ({}), validate: smallJson(20_000) },
  extraExercises: [{ _id: false, name: { type: String, trim: true, maxlength: 100, required: true }, sets: { type: Number, min: 1, max: 20, default: 3 }, reps: { type: String, maxlength: 30, default: '10' } }],
  // { "<meal slot>": true } for meals eaten as planned
  meals: { type: Schema.Types.Mixed, default: () => ({}), validate: smallJson(5_000) },
  extraFood: [{ _id: false, name: { type: String, trim: true, maxlength: 60, required: true }, items: { type: String, trim: true, maxlength: 300, default: '' }, calories: num(0, 10000), protein: num(0, 1000) }],
}, { timestamps: true, minimize: false });
logSchema.index({ owner: 1, date: 1 }, { unique: true });

export const FitnessPlan = mongoose.models.FitnessPlan || model('FitnessPlan', planSchema);
export const FitnessLog = mongoose.models.FitnessLog || model('FitnessLog', logSchema);

const router = Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, error) => res.status(400).json({ error });
const LOG_FIELDS = ['weight', 'waist', 'water', 'steps', 'notes', 'workoutDone', 'minutes', 'exercises', 'extraExercises', 'meals', 'extraFood'];
const logOut = ({ owner, _id, __v, createdAt, ...rest }) => rest;
const todayOf = (req) => (DATE_RE.test(req.query.today || req.body?.today || '') ? req.query.today || req.body.today : new Date().toISOString().slice(0, 10));

const versions = (owner) => FitnessPlan.find({ owner }, { effectiveFrom: 1, plan: 1, updatedAt: 1 }).sort({ effectiveFrom: 1 }).lean();

// The plan in force today (what the editor edits), plus the version dates.
router.get('/plan', ah(async (req, res) => {
  const all = await versions(req.user.email);
  const current = versionFor(all, todayOf(req));
  res.json({
    plan: current?.plan ?? null,
    effectiveFrom: current?.effectiveFrom ?? null,
    versions: all.map((v) => ({ effectiveFrom: v.effectiveFrom, updatedAt: v.updatedAt })),
  });
}));

router.put('/plan', ah(async (req, res) => {
  let plan;
  try { plan = normalizePlan(req.body?.plan); } catch (e) { if (e instanceof PlanError) return bad(res, e.message); throw e; }
  const effectiveFrom = DATE_RE.test(req.body?.effectiveFrom || '') ? req.body.effectiveFrom : todayOf(req);
  const owner = req.user.email;
  await FitnessPlan.findOneAndUpdate({ owner, effectiveFrom }, { $set: { plan } }, { upsert: true, runValidators: true });
  // A newer edit replaces any versions that were scheduled after it.
  await FitnessPlan.deleteMany({ owner, effectiveFrom: { $gt: effectiveFrom } });
  res.json({ plan, effectiveFrom });
}));

// One day: what the plan says, what was logged, and the last weights used for each exercise.
router.get('/day/:date', ah(async (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return bad(res, 'date must be YYYY-MM-DD');
  const owner = req.user.email;
  const [all, log, recent] = await Promise.all([
    versions(owner),
    FitnessLog.findOne({ owner, date }).lean(),
    FitnessLog.find({ owner, date: { $lt: date }, exercises: { $ne: {} } }, { date: 1, exercises: 1 }).sort({ date: -1 }).limit(40).lean(),
  ]);
  const plan = resolveDay(versionFor(all, date)?.plan, date);
  const last = {};
  for (const r of recent) {
    for (const [name, ex] of Object.entries(r.exercises || {})) {
      if (!last[name] && (ex?.sets || []).some((s) => s?.kg != null || s?.reps != null)) last[name] = { date: r.date, sets: ex.sets };
    }
  }
  res.json({ date, plan, log: log ? logOut(log) : null, last });
}));

router.put('/day/:date', ah(async (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return bad(res, 'date must be YYYY-MM-DD');
  const set = Object.fromEntries(LOG_FIELDS.filter((k) => req.body?.[k] !== undefined).map((k) => [k, req.body[k]]));
  const doc = await FitnessLog.findOneAndUpdate({ owner: req.user.email, date }, { $set: set }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }).lean();
  res.json(logOut(doc));
}));

// Journey summary over the whole plan.
router.get('/progress', ah(async (req, res) => {
  const owner = req.user.email;
  const today = todayOf(req);
  const all = await versions(owner);
  const plan = versionFor(all, today)?.plan;
  if (!plan) return res.json(null);
  const logs = await FitnessLog.find({ owner, date: { $gte: plan.meta.startDate > today ? today : plan.meta.startDate, $lte: today } },
    { date: 1, weight: 1, waist: 1, workoutDone: 1, meals: 1, water: 1, steps: 1 }).sort({ date: 1 }).lean();
  const summary = summarize(plan, logs, today, (d) => versionFor(all, d)?.plan);
  const lastWaist = logs.filter((l) => l.waist != null).at(-1);
  res.json({
    ...summary,
    waist: lastWaist ? { date: lastWaist.date, cm: lastWaist.waist } : null,
    days: logs.slice(-14).map((l) => ({ date: l.date, workoutDone: l.workoutDone, weight: l.weight })),
  });
}));

export default router;
