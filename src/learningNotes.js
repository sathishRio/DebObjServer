import { Router } from 'express';
import { LearningNote } from './models.js';

// Learning notes: a topic with a list of points. Used by the Learning tab (session) and the Chrome
// notes extension (learning-notes token); index.js mounts it behind requireAuthOr('learning-notes').
// Every record is scoped to req.user.email.

const router = Router();

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// Accepts one string or a list; drops empty points.
const cleanPoints = (v) => (Array.isArray(v) ? v : [v]).map((p) => str(p, 2000)).filter(Boolean).slice(0, 100);
const notFound = (res) => res.status(404).json({ error: 'Note not found' });

const findNote = (req) => LearningNote.findOne({ _id: req.params.id, owner: req.user.email });

// Newest first. ?courseSlug= narrows to one course; ?limit= caps the list (the extension asks for a few).
router.get(
  '/',
  ah(async (req, res) => {
    const filter = { owner: req.user.email };
    if (req.query.courseSlug) filter.courseSlug = str(req.query.courseSlug, 200);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 500));
    res.json(await LearningNote.find(filter).sort({ updatedAt: -1 }).limit(limit));
  })
);

router.post(
  '/',
  ah(async (req, res) => {
    const topic = str(req.body.topic, 200);
    if (!topic) return res.status(400).json({ error: 'A topic is required' });
    const note = await LearningNote.create({
      owner: req.user.email,
      topic,
      points: cleanPoints(req.body.points || []).map((text) => ({ text })),
      courseSlug: str(req.body.courseSlug, 200),
      pageUrl: /^https?:\/\//.test(req.body.pageUrl || '') ? str(req.body.pageUrl, 1000) : '',
      pageTitle: str(req.body.pageTitle, 300),
    });
    res.status(201).json(note);
  })
);

router.put(
  '/:id',
  ah(async (req, res) => {
    const note = await findNote(req);
    if (!note) return notFound(res);
    const topic = str(req.body.topic, 200);
    if (topic) note.topic = topic;
    await note.save();
    res.json(note);
  })
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const note = await LearningNote.findOneAndDelete({ _id: req.params.id, owner: req.user.email });
    return note ? res.status(204).end() : notFound(res);
  })
);

// Append points to an existing topic.
router.post(
  '/:id/points',
  ah(async (req, res) => {
    const note = await findNote(req);
    if (!note) return notFound(res);
    const points = cleanPoints(req.body.points ?? req.body.text);
    if (!points.length) return res.status(400).json({ error: 'Add at least one point' });
    note.points.push(...points.map((text) => ({ text })));
    await note.save();
    res.json(note);
  })
);

router.put(
  '/:id/points/:pointId',
  ah(async (req, res) => {
    const note = await findNote(req);
    const point = note?.points.id(req.params.pointId);
    if (!point) return notFound(res);
    const text = str(req.body.text, 2000);
    if (!text) return res.status(400).json({ error: 'A point cannot be empty' });
    point.text = text;
    await note.save();
    res.json(note);
  })
);

router.delete(
  '/:id/points/:pointId',
  ah(async (req, res) => {
    const note = await findNote(req);
    const point = note?.points.id(req.params.pointId);
    if (!point) return notFound(res);
    point.deleteOne();
    await note.save();
    res.json(note);
  })
);

export default router;
