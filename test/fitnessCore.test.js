import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizePlan, PlanError, resolveDay, summarize, versionFor, weekday, weekOf } from '../src/fitnessCore.js';

// A copy of the real plan file (hub/Reference/fitness_plan.json).
const raw = JSON.parse(readFileSync(new URL('./fixtures/fitness_plan.json', import.meta.url), 'utf8'));
const plan = normalizePlan(raw);

test('weekday is Monday-first', () => {
  assert.equal(weekday('2026-11-16'), 0);
  assert.equal(weekday('2026-11-15'), 6);
});

test('the reference plan loads', () => {
  assert.equal(plan.weeklySchedule.length, 7);
  assert.equal(plan.weeklySchedule[0].workoutId, 'upper_a');
  assert.equal(plan.phases.find((p) => p.id === 'deload_1').setsFactor, 0.5);
  assert.equal(plan.phases.find((p) => p.id === 'build').extraSetsFirst, 2);
  assert.equal(plan.tracking.weekly.length, 27);
});

test('bad plans are refused with a reason', () => {
  assert.throws(() => normalizePlan({ ...raw, meta: {} }), PlanError);
  const broken = structuredClone(raw);
  broken.weeklySchedule[0].workoutId = 'nope';
  assert.throws(() => normalizePlan(broken), /nope/);
});

test('resolveDay: week, phase, workout, meals, targets', () => {
  const mon = resolveDay(plan, '2026-11-16');
  assert.equal(mon.week, 1);
  assert.equal(mon.phase.id, 'foundation');
  assert.equal(mon.workout.name, 'Upper A - Strength');
  assert.equal(mon.workout.exercises[0].sets, 3);
  assert.equal(mon.meals.length, 6);
  assert.equal(mon.targets.calories, 2200);
  assert.equal(mon.targets.waterMl, 3500);
  assert.equal(mon.weighIn, true);
  assert.equal(mon.targetKg, 82.0);
  const wed = resolveDay(plan, '2026-11-18');
  assert.equal(wed.workout, null);
  assert.equal(wed.dayType, 'rest');
  assert.equal(resolveDay(plan, '2026-11-15').week, 0);
});

test('phases change the sets: deload halves, build adds one to the first two', () => {
  const deload = resolveDay(plan, '2027-01-11'); // week 9 Monday
  assert.equal(weekOf(plan, '2027-01-11'), 9);
  assert.deepEqual(deload.workout.exercises.map((e) => e.sets), [2, 2, 2, 2, 1, 1]);
  const build = resolveDay(plan, '2027-01-18'); // week 10
  assert.deepEqual(build.workout.exercises.map((e) => e.sets), [4, 4, 3, 3, 2, 2]);
});

test('versionFor: edits apply from their date on, past days keep the old plan', () => {
  const v = [{ effectiveFrom: '2026-11-15', plan: 'old' }, { effectiveFrom: '2026-12-01', plan: 'new' }];
  assert.equal(versionFor(v, '2026-11-20').plan, 'old');
  assert.equal(versionFor(v, '2026-12-01').plan, 'new');
  assert.equal(versionFor(v, '2026-11-01').plan, 'old'); // before any version: the first
});

test('summarize: weekly averages, status, loss, streak', () => {
  const logs = [
    { date: '2026-11-16', weight: 82.2, workoutDone: true }, // Mon upper A
    { date: '2026-11-17', workoutDone: true }, // Tue lower A
    { date: '2026-11-18', weight: 81.8 }, // Wed rest
    { date: '2026-11-19', workoutDone: true }, // Thu upper B
    { date: '2026-11-20', weight: 81.9, workoutDone: true }, // Fri lower B
  ];
  const s = summarize(plan, logs, '2026-11-22');
  const w1 = s.weeks.find((w) => w.week === 1);
  assert.equal(w1.actualAvgKg, 82);
  assert.equal(w1.status, 'on_track');
  assert.equal(s.lost, 0.3);
  assert.equal(s.streak, 7); // Mon-Sun: all training done, other days rest
  assert.deepEqual(s.sessionsThisWeek, { done: 4, planned: 4 });
  const missed = summarize(plan, logs.filter((l) => l.date !== '2026-11-19'), '2026-11-22');
  assert.equal(missed.streak, 3); // Fri, Sat, Sun
});
