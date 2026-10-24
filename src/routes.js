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

const TASK_FIELDS = ['title', 'notes', 'categoryId', 'priority', 'status', 'dueDate', 'dueTime', 'reminder', 'phaseId', 'topicId', 'mode'];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Filters: ?q=search&status=todo&categoryId=..&priority=high&phaseId=..&mode=office
router.get(
  '/tasks',
  ah(async (req, res) => {
    const filter = pick(req.query, ['status', 'categoryId', 'priority', 'phaseId', 'mode']);
    if (req.query.q) filter.title = { $regex: escapeRegex(req.query.q), $options: 'i' };
    res.json(await Task.find(filter).sort({ createdAt: -1 }));
  })
);

router.post(
  '/tasks',
  ah(async (req, res) => {
    const data = pick(req.body, TASK_FIELDS);
    if (!data.phaseId) data.topicId = null;
    if (data.status === 'done') data.completedAt = new Date();
    res.status(201).json(await Task.create(data));
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
    task.set(data);
    res.json(await task.save());
  })
);

router.delete(
  '/tasks/:id',
  ah(async (req, res) => {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return notFound(res, 'Task');
    await Note.updateMany({ taskId: task._id }, { taskId: null });
    res.status(204).end();
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
