// Loads Learn courses into the database (same MONGODB_URI).  Usage: npm run seed:learn
// Each course folder holds course.json (metadata) and plan.json (the session-by-session plan).
// Re-running replaces the course's content. Pass --reset to also delete every learner's progress,
// milestones and settings for the course (a backup of progress is written to server/backups first).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connect } from './db.js';
import { LearnCourse, LearnMilestone, LearnPref, LearnProgress, LearnSession, LearnStage, LearnWeek } from './learnModels.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'learn');
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const RESET = process.argv.includes('--reset');

// Splits session Markdown into the text before the first block and one section per "### Name (N min)" heading.
// Lines inside ``` / ~~~ fences are never treated as headings.
function splitSections(md) {
  const intro = [];
  const sections = [];
  let fence = null;
  for (const line of md.split(/\r?\n/)) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence ? (fence === f[1] ? null : fence) : f[1];
    const h = !fence && line.match(/^### (.+?)(?:\s*\((\d+) min\))?\s*$/);
    if (h) sections.push({ name: h[1].trim(), minutes: h[2] ? Number(h[2]) : null, lines: [] });
    else (sections.at(-1)?.lines || intro).push(line);
  }
  return { intro: intro.join('\n').trim(), sections: sections.map(({ lines, ...s }) => ({ ...s, text: lines.join('\n').trim() })) };
}

const stageOf = (label) => {
  const m = String(label).match(/^Stage\s+(\d+):\s*(.+)$/);
  return m ? { n: Number(m[1]), title: m[2].trim() } : null;
};

async function resetLearners(slug) {
  const old = await LearnProgress.find({ course: slug }).lean();
  if (old.length) {
    const dir = path.join(DATA, '..', '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `learn_progress-${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(old, null, 1));
    console.log(`  progress backup: ${file}`);
  }
  const [p, m, s] = await Promise.all([
    LearnProgress.deleteMany({ course: slug }),
    LearnMilestone.deleteMany({ course: slug }),
    LearnPref.deleteMany({ course: slug }),
  ]);
  console.log(`  learner data deleted: ${p.deletedCount} progress, ${m.deletedCount} milestones, ${s.deletedCount} settings`);
}

async function seedCourse(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(DATA, dir, 'course.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(DATA, dir, 'plan.json'), 'utf8'));

  const stages = new Map();
  const sessions = plan.sessions.map((s) => {
    const st = stageOf(s.stage);
    if (!st) throw new Error(`Unrecognised stage "${s.stage}" (week ${s.week} ${s.weekday})`);
    const day = DAY_NAMES.indexOf(s.weekday);
    if (day < 0) throw new Error(`Unrecognised weekday "${s.weekday}" (week ${s.week})`);
    const stage = stages.get(st.n) || { n: st.n, title: st.title, weeks: [s.week, s.week], milestone: '' };
    stage.weeks = [Math.min(stage.weeks[0], s.week), Math.max(stage.weeks[1], s.week)];
    if (s.milestone) stage.milestone = s.title;
    stages.set(st.n, stage);

    const { intro, sections } = splitSections(s.content || '');
    const goal = (intro.match(/\*\*Goal:\*\*\s*(.+)/) || [])[1]?.replace(/\s*\*\*MILESTONE\*\*\s*$/, '').trim() || '';
    // Prefer the plan's block list (names + minutes); attach the matching section text.
    const blocks = s.blocks?.length ? s.blocks : sections.map(({ name, minutes }) => ({ name, minutes }));
    const out = blocks.map((b, i) => ({
      name: b.name,
      minutes: b.minutes,
      text: (sections.find((x) => x.name === b.name) || sections[i])?.text || '',
    }));
    return {
      course: meta.slug, week: s.week, day, dayNo: s.day ?? null, stage: st.n, type: s.type, title: s.title,
      goal, minutes: s.minutes, milestone: !!s.milestone,
      intro: intro.replace(/^\*\*Goal:\*\*.*$/m, '').trim(), sections: out,
    };
  });

  const weeks = [...new Set(sessions.map((s) => s.week))].sort((a, b) => a - b).map((week) => {
    const ws = sessions.filter((s) => s.week === week).sort((a, b) => a.day - b.day);
    const study = ws.filter((s) => s.type === 'study');
    return { course: meta.slug, week, stage: ws[0].stage, title: (study[0] || ws[0]).title };
  });

  if (RESET) await resetLearners(meta.slug);
  // Replace this course's content.
  await Promise.all([LearnStage.deleteMany({ course: meta.slug }), LearnWeek.deleteMany({ course: meta.slug }), LearnSession.deleteMany({ course: meta.slug })]);
  await LearnStage.insertMany([...stages.values()].map((st) => ({ ...st, course: meta.slug })));
  await LearnWeek.insertMany(weeks);
  await LearnSession.insertMany(sessions);
  await LearnCourse.replaceOne(
    { slug: meta.slug },
    { ...meta, minutesPerDay: meta.minutesPerDay || plan.minutes_per_day || 60, totalWeeks: weeks.length, totalDays: sessions.length },
    { upsert: true }
  );
  const practice = sessions.filter((s) => s.type === 'practice').length;
  console.log(`${meta.title}: ${stages.size} stages, ${weeks.length} weeks, ${sessions.length} sessions (${sessions.length - practice} study, ${practice} practice)`);
}

await connect();
for (const dir of fs.readdirSync(DATA)) {
  if (fs.existsSync(path.join(DATA, dir, 'course.json'))) await seedCourse(dir);
}
await mongoose.disconnect();
