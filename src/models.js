import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// Expose `id` instead of `_id` and drop `__v` in every JSON response (incl. subdocuments).
mongoose.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    return ret;
  },
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Tasks and sticky notes each belong to one workspace. Older records without it load as 'personal'.
export const MODES = ['office', 'personal'];
const mode = { type: String, enum: MODES, default: 'personal' };

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    color: { type: String, default: '#4F46E5' },
  },
  { timestamps: true }
);

const taskSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    notes: { type: String, default: '' },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
    status: { type: String, enum: ['todo', 'in_progress', 'done'], default: 'todo' },
    dueDate: { type: String, match: DATE_RE, default: null },
    dueTime: { type: String, match: TIME_RE, default: null },
    reminder: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false }, // pinned tasks list first
    background: { type: Boolean, default: false }, // hidden from task lists unless asked for
    // Optional link to the career plan: a phase, and optionally one topic inside it.
    phaseId: { type: Schema.Types.ObjectId, ref: 'Phase', default: null },
    topicId: { type: Schema.Types.ObjectId, default: null },
    completedAt: { type: Date, default: null },
    // Set on an action that belongs to a main objective (another task). One level only:
    // an objective is never itself an action. See syncObjective in routes.js.
    parentId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    mode,
  },
  { timestamps: true }
);
taskSchema.index({ status: 1, dueDate: 1 });
taskSchema.index({ parentId: 1 });
taskSchema.index({ title: 'text', notes: 'text' });

const topicSchema = new Schema({
  title: { type: String, required: true, trim: true },
  done: { type: Boolean, default: false },
});

const phaseSchema = new Schema(
  {
    order: { type: Number, default: 0 },
    title: { type: String, required: true, trim: true },
    months: { type: String, default: '' },
    deliverable: { type: String, default: '' },
    deliverableDone: { type: Boolean, default: false },
    notes: { type: String, default: '' },
    topics: [topicSchema],
  },
  { timestamps: true }
);

const certificationSchema = new Schema(
  {
    code: { type: String, required: true, trim: true },
    name: { type: String, default: '' },
    status: { type: String, enum: ['planned', 'studying', 'scheduled', 'passed'], default: 'planned' },
    optional: { type: Boolean, default: false },
    targetDate: { type: String, match: DATE_RE, default: null },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Sticky notes (web: 3D desk; mobile: list). Colour is a DevOBJ zone name; x/y is where the
// note was dragged on the desk, 0–1 across and down, or null to let the desk place it.
export const NOTE_COLORS = ['taxi', 'blue', 'green', 'orange', 'violet', 'pink'];
const coord = { type: Number, min: 0, max: 1, default: null };
const noteSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 500 },
    color: { type: String, enum: NOTE_COLORS, default: 'taxi' },
    pinned: { type: Boolean, default: false },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    x: coord,
    y: coord,
    mode,
  },
  { timestamps: true }
);

// Single document holding the "who I am / where I'm going" part of the career page.
const profileSchema = new Schema(
  {
    goal: { type: String, default: '' },
    currentRole: { type: String, default: '' },
    experience: { type: String, default: '' },
    location: { type: String, default: '' },
    currentSalary: { type: String, default: '' },
    shortTermTarget: { type: String, default: '' },
    mediumTermTarget: { type: String, default: '' },
    targetRoles: [String],
    skillPriorities: [String],
    principle: { type: String, default: '' },
  },
  { timestamps: true }
);

/* ---------- Password vault (web only; see vault.js for the crypto) ---------- */

// One per signed-in account: the vault's random data key, encrypted with a key derived
// from the 4-digit PIN + VAULT_SECRET, plus the wrong-PIN lockout counters.
const vaultMetaSchema = new Schema(
  {
    owner: { type: String, required: true, unique: true }, // Google email
    kdfSalt: { type: String, required: true },
    wrappedKey: { type: String, required: true },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

// Title, username and URL stay readable for listing and search; password and notes are encrypted.
const vaultEntrySchema = new Schema(
  {
    owner: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    username: { type: String, default: '', trim: true, maxlength: 300 },
    url: { type: String, default: '', trim: true, maxlength: 500 },
    password: { type: String, required: true }, // ciphertext
    notes: { type: String, default: '' }, // ciphertext or ''
  },
  { timestamps: true }
);
vaultEntrySchema.index({ owner: 1, title: 1 });
// Never send ciphertext to clients; secrets only leave through the reveal endpoint, decrypted.
vaultEntrySchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.hasNotes = !!ret.notes;
    delete ret._id;
    delete ret.password;
    delete ret.notes;
    delete ret.owner;
    return ret;
  },
});

export const VaultMeta = model('VaultMeta', vaultMetaSchema);
export const VaultEntry = model('VaultEntry', vaultEntrySchema);

export const Category = model('Category', categorySchema);
export const Task = model('Task', taskSchema);
export const Phase = model('Phase', phaseSchema);
export const Certification = model('Certification', certificationSchema);
export const Profile = model('Profile', profileSchema);
export const Note = model('Note', noteSchema);
