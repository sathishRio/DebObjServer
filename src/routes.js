import { Router } from 'express';
import { Category, Certification, Note, Phase, Profile, Task } from './models.js';

const router = Router();

// Express 4 does not forward rejected promises to the error handler on its own.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });

const updateOpts = { new: true, runValidators: true };

/* ---------- Bootstrap: everything the app needs on launch ---------- */

router.get(
  '/bootstrap',
  ah(async (_req, res) => {
    const [categories, tasks, phases, certifications, profile, notes] = await Promise.all([
      Category.find().sort({ createdAt: 1 }),
      Task.find().sort({ createdAt: -1 }),
      Phase.find().sort({ order: 1 }),
      Certification.find().sort({ order: 1 }),
      Profile.findOne(),
      Note.find().sort({ pinned: -1, updatedAt: -1 }),
    ]);
    res.json({ categories, tasks, phases, certifications, profile, notes });
  })
);

/* ---------- Categories ---------- */

const CATEGORY_FIELDS = ['name', 'color'];

router.get('/categories', ah(async (_req, res) => res.json(await Category.find().sort({ createdAt: 1 }))));

router.post(
  '/categories',
  ah(async (req, res) => res.status(201).json(await Category.create(pick(req.body, CATEGORY_FIELDS))))
);

router.put(
  '/categories/:id',
  ah(async (req, res) => {
    const cat = await Category.findByIdAndUpdate(req.params.id, pick(req.body, CATEGORY_FIELDS), updateOpts);
    return cat ? res.json(cat) : notFound(res, 'Category');
  })
);

router.delete(
  '/categories/:id',
  ah(async (req, res) => {
    const cat = await Category.findByIdAndDelete(req.params.id);
    if (!cat) return notFound(res, 'Category');
    // Tasks in a deleted category become uncategorized rather than being lost.
    await Task.updateMany({ categoryId: cat._id }, { categoryId: null });
    res.status(204).end();
  })
);

/* ---------- Tasks ---------- */

const TASK_FIELDS = ['title', 'notes', 'categoryId', 'priority', 'status', 'dueDate', 'dueTime', 'reminder', 'pinned', 'background', 'phaseId', 'topicId', 'mode', 'parentId'];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const badRequest = (res, error) => res.status(400).json({ error });

// Checks a requested parentId for `task` (null when creating). Returns the objective, or an error message.
async function resolveObjective(parentId, task) {
  if (task && String(parentId) === String(task._id)) return 'A task cannot be its own objective';
  const objective = await Task.findById(parentId).catch(() => null);
  if (!objective) return 'Objective not found';
  if (objective.parentId) return 'An action cannot have actions of its own';
  if (task && (await Task.exists({ parentId: task._id }))) return 'This task already has actions, so it cannot become one';
  return objective;
}

// An objective is done exactly when all of its actions are; it reopens when one is reopened.
// Returns the objective if its status changed, so the client can update it too.
async function syncObjective(parentId) {
  if (!parentId) return null;
  const objective = await Task.findById(parentId);
  if (!objective) return null;
  const actions = await Task.find({ parentId }, 'status');
  if (!actions.length) return null;
  const allDone = actions.every((a) => a.status === 'done');
  if (allDone && objective.status !== 'done') {
    objective.set({ status: 'done', completedAt: new Date() });
  } else if (!allDone && objective.status === 'done') {
    const started = actions.some((a) => a.status !== 'todo');
    objective.set({ status: started ? 'in_progress' : 'todo', completedAt: null });
  } else {
    return null;
  }
  return objective.save();
}

// Task responses carry `objectives`: any objectives whose status changed as a side effect.
const withObjectives = async (task, ...parentIds) => {
  const ids = [...new Set(parentIds.filter(Boolean).map(String))];
  const objectives = (await Promise.all(ids.map(syncObjective))).filter(Boolean);
  return { ...task.toJSON(), objectives };
};

// Filters: ?q=search&status=todo&categoryId=..&priority=high&phaseId=..&mode=office&parentId=..
router.get(
  '/tasks',
  ah(async (req, res) => {
    const filter = pick(req.query, ['status', 'categoryId', 'priority', 'phaseId', 'mode', 'parentId']);
    if (req.query.q) filter.title = { $regex: escapeRegex(req.query.q), $options: 'i' };
    res.json(await Task.find(filter).sort({ createdAt: -1 }));
  })
);

router.post(
  '/tasks',
  ah(async (req, res) => {
    const data = pick(req.body, TASK_FIELDS);
    if (!data.phaseId) data.topicId = null;
    if (data.parentId) {
      const objective = await resolveObjective(data.parentId, null);
      if (typeof objective === 'string') return badRequest(res, objective);
      data.mode = objective.mode; // actions live in their objective's workspace
    }
    if (data.status === 'done') data.completedAt = new Date();
    const task = await Task.create(data);
    res.status(201).json(await withObjectives(task, task.parentId));
  })
);

router.put(
  '/tasks/:id',
  ah(async (req, res) => {
    const task = await Task.findById(req.params.id);
    if (!task) return notFound(res, 'Task');
    const data = pick(req.body, TASK_FIELDS);
    if (data.phaseId === null) data.topicId = null;
    if (data.status && data.status !== task.status) data.completedAt = data.status === 'done' ? new Date() : null;
    const oldParentId = task.parentId;
    if (data.parentId) {
      const objective = await resolveObjective(data.parentId, task);
      if (typeof objective === 'string') return badRequest(res, objective);
      data.mode = objective.mode;
    } else if (task.parentId && data.mode) {
      delete data.mode; // an action follows its objective's workspace
    }
    task.set(data);
    await task.save();
    // Moving an objective to the other workspace takes its actions along.
    if (data.mode && !task.parentId) await Task.updateMany({ parentId: task._id }, { mode: task.mode });
    res.json(await withObjectives(task, oldParentId, task.parentId));
  })
);

// Deleting an objective deletes its actions too. Responds with every removed id.
router.delete(
  '/tasks/:id',
  ah(async (req, res) => {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return notFound(res, 'Task');
    const actions = await Task.find({ parentId: task._id }, '_id');
    const removedIds = [task._id, ...actions.map((a) => a._id)];
    await Task.deleteMany({ parentId: task._id });
    await Note.updateMany({ taskId: { $in: removedIds } }, { taskId: null });
    const objective = await syncObjective(task.parentId);
    res.json({ removedIds: removedIds.map(String), objectives: objective ? [objective] : [] });
  })
);

/* ---------- Sticky notes ---------- */

const NOTE_FIELDS = ['text', 'color', 'pinned', 'taskId', 'x', 'y', 'mode'];

router.get('/notes', ah(async (_req, res) => res.json(await Note.find().sort({ pinned: -1, updatedAt: -1 }))));

router.post(
  '/notes',
  ah(async (req, res) => res.status(201).json(await Note.create(pick(req.body, NOTE_FIELDS))))
);

router.put(
  '/notes/:id',
  ah(async (req, res) => {
    const note = await Note.findByIdAndUpdate(req.params.id, pick(req.body, NOTE_FIELDS), updateOpts);
    return note ? res.json(note) : notFound(res, 'Note');
  })
);

router.delete(
  '/notes/:id',
  ah(async (req, res) => {
    const note = await Note.findByIdAndDelete(req.params.id);
    return note ? res.status(204).end() : notFound(res, 'Note');
  })
);

/* ---------- Career profile ---------- */

const PROFILE_FIELDS = [
  'goal', 'currentRole', 'experience', 'location', 'currentSalary',
  'shortTermTarget', 'mediumTermTarget', 'targetRoles', 'skillPriorities', 'principle',
];

router.get('/profile', ah(async (_req, res) => res.json(await Profile.findOne())));

router.put(
  '/profile',
  ah(async (req, res) => {
    const profile = await Profile.findOneAndUpdate({}, pick(req.body, PROFILE_FIELDS), { ...updateOpts, upsert: true });
    res.json(profile);
  })
);

/* ---------- Career phases & topics ---------- */

const PHASE_FIELDS = ['order', 'title', 'months', 'deliverable', 'deliverableDone', 'notes'];

router.get('/phases', ah(async (_req, res) => res.json(await Phase.find().sort({ order: 1 }))));

router.post(
  '/phases',
  ah(async (req, res) => {
    const data = pick(req.body, [...PHASE_FIELDS, 'topics']);
    if (data.order === undefined) data.order = (await Phase.countDocuments()) + 1;
    res.status(201).json(await Phase.create(data));
  })
);

router.put(
  '/phases/:id',
  ah(async (req, res) => {
    const phase = await Phase.findByIdAndUpdate(req.params.id, pick(req.body, PHASE_FIELDS), updateOpts);
    return phase ? res.json(phase) : notFound(res, 'Phase');
  })
);

router.delete(
  '/phases/:id',
  ah(async (req, res) => {
    const phase = await Phase.findByIdAndDelete(req.params.id);
    if (!phase) return notFound(res, 'Phase');
    await Task.updateMany({ phaseId: phase._id }, { phaseId: null, topicId: null });
    res.status(204).end();
  })
);

// Topic endpoints return the whole updated phase so the app can replace it in one go.
router.post(
  '/phases/:id/topics',
  ah(async (req, res) => {
    const phase = await Phase.findById(req.params.id);
    if (!phase) return notFound(res, 'Phase');
    phase.topics.push(pick(req.body, ['title', 'done']));
    res.status(201).json(await phase.save());
  })
);

router.put(
  '/phases/:id/topics/:topicId',
  ah(async (req, res) => {
    const phase = await Phase.findById(req.params.id);
    const topic = phase?.topics.id(req.params.topicId);
    if (!topic) return notFound(res, 'Topic');
    topic.set(pick(req.body, ['title', 'done']));
    res.json(await phase.save());
  })
);

router.delete(
  '/phases/:id/topics/:topicId',
  ah(async (req, res) => {
    const phase = await Phase.findById(req.params.id);
    const topic = phase?.topics.id(req.params.topicId);
    if (!topic) return notFound(res, 'Topic');
    topic.deleteOne();
    await phase.save();
    await Task.updateMany({ topicId: req.params.topicId }, { topicId: null });
    res.json(phase);
  })
);

/* ---------- Certifications ---------- */

const CERT_FIELDS = ['code', 'name', 'status', 'optional', 'targetDate', 'order'];

router.get('/certifications', ah(async (_req, res) => res.json(await Certification.find().sort({ order: 1 }))));

router.post(
  '/certifications',
  ah(async (req, res) => {
    const data = pick(req.body, CERT_FIELDS);
    if (data.order === undefined) data.order = (await Certification.countDocuments()) + 1;
    res.status(201).json(await Certification.create(data));
  })
);

router.put(
  '/certifications/:id',
  ah(async (req, res) => {
    const cert = await Certification.findByIdAndUpdate(req.params.id, pick(req.body, CERT_FIELDS), updateOpts);
    return cert ? res.json(cert) : notFound(res, 'Certification');
  })
);

router.delete(
  '/certifications/:id',
  ah(async (req, res) => {
    const cert = await Certification.findByIdAndDelete(req.params.id);
    return cert ? res.status(204).end() : notFound(res, 'Certification');
  })
);

export default router;
