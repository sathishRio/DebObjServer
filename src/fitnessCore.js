// Pure helpers for the fitness tracker (no database), so they can be unit tested.
//
// The user keeps ONE central plan (the shape of Reference/fitness_plan.json): phases, a workout
// library, a weekly schedule with meals, and weekly weight targets. Every saved edit becomes a new
// plan version effective from a date, so upcoming days follow the latest plan while past days keep
// the plan they were done with. A day log only stores what happened (ticks, weights lifted, body
// numbers), never a copy of the plan.

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export const DAY_TYPES = ['training', 'rest', 'active_recovery'];

const DAY_MS = 86400000;
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
// Monday = 0 … Sunday = 6.
export const weekday = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

class PlanError extends Error {}
export { PlanError };
const need = (cond, msg) => { if (!cond) throw new PlanError(msg); };
const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const numOr = (v, d = null) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));

// Checks and tidies a plan (imported file or edited in the app). Returns a clean copy.
export function normalizePlan(input) {
  need(input && typeof input === 'object', 'Plan must be a JSON object');
  const p = structuredClone(input);
  p.meta = p.meta || {};
  need(DATE_RE.test(p.meta.startDate || ''), 'meta.startDate must be YYYY-MM-DD');
  p.meta.planName = str(p.meta.planName, 120) || 'My plan';
  p.meta.durationWeeks = Math.max(1, Math.min(260, Math.round(numOr(p.meta.durationWeeks, 26))));
  p.meta.endDate = addDays(p.meta.startDate, p.meta.durationWeeks * 7);
  p.user = p.user || {};

  need(p.workouts && typeof p.workouts === 'object' && !Array.isArray(p.workouts), 'workouts must be an object of workout id → workout');
  for (const [id, w] of Object.entries(p.workouts)) {
    need(/^[a-z0-9_-]{1,40}$/i.test(id), `Workout id "${id}" may only use letters, digits, - and _`);
    w.name = str(w.name, 80) || id;
    w.focus = Array.isArray(w.focus) ? w.focus.map((f) => str(f, 30)).filter(Boolean) : [];
    w.finisher = str(w.finisher, 200);
    need(Array.isArray(w.exercises), `Workout "${w.name}" needs an exercises list`);
    w.exercises = w.exercises.filter((e) => str(e?.name)).map((e) => ({
      name: str(e.name, 100), sets: Math.max(1, Math.min(20, Math.round(numOr(e.sets, 3)))), reps: str(e.reps, 30) || '10', type: ['compound', 'accessory', 'core'].includes(e.type) ? e.type : 'accessory',
    }));
  }

  need(Array.isArray(p.weeklySchedule) && p.weeklySchedule.length === 7, 'weeklySchedule must list 7 days');
  const byDay = Object.fromEntries(p.weeklySchedule.map((d) => [String(d.day).toLowerCase(), d]));
  p.weeklySchedule = WEEKDAYS.map((day) => {
    const d = byDay[day];
    need(d, `weeklySchedule is missing ${day}`);
    const workoutId = d.workoutId || null;
    need(!workoutId || p.workouts[workoutId], `${day} uses workout "${workoutId}", which isn't in workouts`);
    return {
      day,
      dayType: DAY_TYPES.includes(d.dayType) ? d.dayType : workoutId ? 'training' : 'rest',
      isVegDay: Boolean(d.isVegDay),
      workoutId,
      recovery: { type: str(d.recovery?.type, 40), items: (d.recovery?.items || []).map((i) => str(i, 200)).filter(Boolean) },
      meals: (d.meals || []).filter((m) => str(m?.slot) || str(m?.items)).map((m, i) => ({
        slot: str(m.slot, 40) || `meal_${i + 1}`, time: /^\d{2}:\d{2}$/.test(m.time || '') ? m.time : '', cuisine: str(m.cuisine, 30), items: str(m.items, 400),
        ...(m.isTreatMeal ? { isTreatMeal: true } : {}),
      })),
    };
  });

  p.phases = (Array.isArray(p.phases) ? p.phases : []).map((ph, i) => {
    const id = str(ph.id, 40) || `phase_${i + 1}`;
    const weeks = Array.isArray(ph.weeks) ? ph.weeks.map((w) => Math.round(Number(w))) : [1, p.meta.durationWeeks];
    need(weeks.length === 2 && weeks[0] >= 1 && weeks[1] >= weeks[0], `Phase "${id}" weeks must be [from, to]`);
    return {
      ...ph,
      id, name: str(ph.name, 60) || id, weeks,
      calories: numOr(ph.calories), proteinG: numOr(ph.proteinG), fatG: numOr(ph.fatG), carbsG: numOr(ph.carbsG),
      waterL: numOr(ph.waterL), stepsPerDay: numOr(ph.stepsPerDay), training: str(ph.training, 400), cardio: str(ph.cardio, 300),
      // How the phase changes the written workouts. Defaults follow the plan's wording.
      setsFactor: numOr(ph.setsFactor, id.startsWith('deload') ? 0.5 : 1),
      extraSetsFirst: numOr(ph.extraSetsFirst, ['build', 'cut_strengthen'].includes(id) ? 2 : 0),
    };
  });

  // Weekly weight targets only; actual weigh-ins come from day logs.
  p.tracking = p.tracking || {};
  p.tracking.weighInDays = (p.tracking.weighInDays || []).map((d) => String(d).toLowerCase()).filter((d) => WEEKDAYS.includes(d));
  p.tracking.weekly = (p.tracking.weekly || []).filter((w) => Number.isFinite(Number(w.week))).map((w) => ({
    week: Number(w.week), weekEnding: DATE_RE.test(w.weekEnding || '') ? w.weekEnding : addDays(p.meta.startDate, Number(w.week) * 7 - 1),
    phase: str(w.phase, 40), targetKg: numOr(w.targetKg), photo: Boolean(w.photo), notes: str(w.notes, 200),
  }));
  p.tracking.monthly = (p.tracking.monthly || []).filter((m) => DATE_RE.test(m.from || '') && DATE_RE.test(m.to || '')).map((m) => ({
    month: Number(m.month), from: m.from, to: m.to, startTargetKg: numOr(m.startTargetKg), endTargetKg: numOr(m.endTargetKg), review: str(m.review, 1000),
  }));
  return p;
}

// Week 1 starts on meta.startDate; 0 = before the plan, > durationWeeks = after it.
export const weekOf = (plan, date) => Math.floor(daysBetween(plan.meta.startDate, date) / 7) + 1;
export const phaseFor = (plan, week) => plan.phases.find((ph) => week >= ph.weeks[0] && week <= ph.weeks[1]) || null;

// The workout for a phase: deloads cut sets, build phases add a set to the first exercises.
export function phasedExercises(exercises, phase) {
  return exercises.map((e, i) => {
    let sets = e.sets;
    if (phase?.extraSetsFirst && i < phase.extraSetsFirst) sets += 1;
    if (phase?.setsFactor && phase.setsFactor !== 1) sets = Math.max(1, Math.ceil(sets * phase.setsFactor));
    return { ...e, sets };
  });
}

// What the plan says for one date.
export function resolveDay(plan, date) {
  if (!plan) return null;
  const week = weekOf(plan, date);
  const phase = phaseFor(plan, week);
  const sched = plan.weeklySchedule[weekday(date)];
  const w = sched.workoutId ? plan.workouts[sched.workoutId] : null;
  const target = plan.tracking.weekly.find((t) => t.week === week) || null;
  const special = (plan.specialPeriods || []).find((s) => s.approxStart <= date && date <= s.approxEnd) || null;
  return {
    date,
    week,
    inPlan: week >= 1 && week <= plan.meta.durationWeeks,
    phase: phase && { id: phase.id, name: phase.name, training: phase.training, cardio: phase.cardio },
    day: sched.day,
    dayType: sched.dayType,
    isVegDay: sched.isVegDay,
    workout: w && { id: sched.workoutId, name: w.name, focus: w.focus, finisher: w.finisher, exercises: phasedExercises(w.exercises, phase) },
    warmup: w ? plan.warmup || null : null,
    recovery: sched.recovery,
    meals: sched.meals,
    targets: {
      calories: phase?.calories ?? null, proteinG: phase?.proteinG ?? null, fatG: phase?.fatG ?? null, carbsG: phase?.carbsG ?? null,
      waterMl: phase?.waterL != null ? Math.round(phase.waterL * 1000) : null, steps: phase?.stepsPerDay ?? null,
    },
    weighIn: plan.tracking.weighInDays.includes(sched.day),
    targetKg: target?.targetKg ?? null,
    photo: Boolean(target?.photo && weekday(date) === 6),
    special: special && { id: special.id, note: special.note },
  };
}

// Pick the plan version in force on a date: the latest with effectiveFrom <= date (else the earliest).
export function versionFor(versions, date) {
  const sorted = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return sorted.filter((v) => v.effectiveFrom <= date).at(-1) || sorted[0] || null;
}

const round1 = (n) => Math.round(n * 10) / 10;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// The journey: weekly targets vs actual weigh-ins, monthly totals, streak and headline numbers.
// `logs` are day logs ({ date, weight, workoutDone, ... }); `planAt(date)` gives the plan for a date.
export function summarize(plan, logs, today, planAt = () => plan) {
  if (!plan) return null;
  const byDate = new Map(logs.map((l) => [l.date, l]));
  const weights = logs.filter((l) => l.weight != null).sort((a, b) => a.date.localeCompare(b.date)).map((l) => ({ date: l.date, kg: l.weight }));
  const start = numOr(plan.user.startWeightKg, weights[0]?.kg ?? null);
  const goal = numOr(plan.user.targetWeightKg);
  const tol = numOr(plan.tracking.onTrackToleranceKg, 0.5);

  const weeks = plan.tracking.weekly.map((t) => {
    const from = addDays(t.weekEnding, -6);
    const ins = weights.filter((w) => w.date >= from && w.date <= t.weekEnding);
    const avg = t.week === 0 && !ins.length ? start : ins.length ? round1(mean(ins.map((w) => w.kg))) : null;
    const delta = avg != null && t.targetKg != null ? round1(avg - t.targetKg) : null;
    return { ...t, from, weighIns: ins, actualAvgKg: avg, deltaKg: delta, status: delta == null ? (t.weekEnding < today ? 'missed' : 'upcoming') : delta <= tol ? 'on_track' : 'behind' };
  });
  const latestAvg = weeks.filter((w) => w.actualAvgKg != null && w.week > 0).at(-1)?.actualAvgKg ?? weights.at(-1)?.kg ?? start;
  const current = weights.at(-1)?.kg ?? start;

  const months = plan.tracking.monthly.map((m) => {
    const last = weeks.filter((w) => w.weekEnding >= m.from && w.weekEnding <= m.to && w.actualAvgKg != null).at(-1);
    return { ...m, targetLossKg: m.startTargetKg != null && m.endTargetKg != null ? round1(m.startTargetKg - m.endTargetKg) : null, actualEndKg: last?.actualAvgKg ?? null };
  });
  months.forEach((m, i) => {
    const prev = i ? months[i - 1].actualEndKg : start;
    m.actualLossKg = m.actualEndKg != null && prev != null ? round1(prev - m.actualEndKg) : null;
  });

  // Streak: back from today (or yesterday if today's workout isn't done yet); a training day must
  // be done, other days pass. Days before the plan end it.
  const ok = (date) => {
    const r = resolveDay(planAt(date), date);
    if (!r || r.week < 1) return false;
    return r.dayType !== 'training' || Boolean(byDate.get(date)?.workoutDone);
  };
  let streak = 0;
  let cursor = ok(today) ? today : addDays(today, -1);
  while (streak < 3650 && ok(cursor)) { streak += 1; cursor = addDays(cursor, -1); }

  // Training sessions in the current plan week.
  const week = weekOf(plan, today);
  const weekStart = addDays(plan.meta.startDate, (week - 1) * 7);
  let planned = 0;
  let done = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(weekStart, i);
    if (resolveDay(planAt(d), d)?.dayType === 'training') { planned += 1; if (byDate.get(d)?.workoutDone) done += 1; }
  }

  const lost = start != null && latestAvg != null ? round1(start - latestAvg) : null;
  return {
    planName: plan.meta.planName,
    week, durationWeeks: plan.meta.durationWeeks, phase: phaseFor(plan, week)?.name ?? null,
    start, goal, current, latestAvg,
    lost,
    toGo: goal != null && latestAvg != null ? round1(Math.max(0, latestAvg - goal)) : null,
    percent: lost != null && goal != null && start !== goal ? Math.max(0, Math.min(100, Math.round((lost / (start - goal)) * 100))) : null,
    bmi: plan.user.heightCm && current ? round1(current / (plan.user.heightCm / 100) ** 2) : null,
    streak,
    sessionsThisWeek: { done, planned },
    weights,
    weeks,
    months,
  };
}
