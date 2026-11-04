import mongoose from 'mongoose';

// "Learn" site: daily courses (first course: AI Journey).
// Content collections are shared by everyone; progress is per user (owner = email).
// Collections use the learn_ prefix so they never clash with the Coursera "learning" models.
const { Schema } = mongoose;

const linkSchema = new Schema({ label: String, url: String }, { _id: false });

const courseSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    tagline: String,
    description: String,
    order: { type: Number, default: 0 },
    totalWeeks: Number,
    totalDays: Number,
    minutesPerDay: { type: Number, default: 45 }, // default timer length; learners can set their own
  },
  { timestamps: true, collection: 'learn_courses' }
);

const stageSchema = new Schema(
  {
    course: { type: String, required: true },
    n: { type: Number, required: true },
    title: String,
    weeks: [Number], // [from, to]
    months: String,
    goal: String,
    resources: String,
    milestone: String,
    tip: String,
    links: [linkSchema],
  },
  { collection: 'learn_stages' }
);
stageSchema.index({ course: 1, n: 1 }, { unique: true });

const weekSchema = new Schema(
  {
    course: { type: String, required: true },
    week: { type: Number, required: true },
    stage: Number,
    title: String,
  },
  { collection: 'learn_weeks' }
);
weekSchema.index({ course: 1, week: 1 }, { unique: true });

const sessionSchema = new Schema(
  {
    course: { type: String, required: true },
    week: { type: Number, required: true },
    day: { type: Number, required: true, min: 0, max: 6 }, // 0 = Monday
    dayNo: Number, // study-day number in the plan (null on practice days)
    stage: Number,
    type: { type: String, enum: ['study', 'practice'], default: 'study' },
    title: String,
    goal: String,
    minutes: Number,
    milestone: { type: Boolean, default: false },
    intro: String, // Markdown before the first block
    // One section per block (e.g. Learn 30 / Exercise 20 / Wrap-up 10), each with its Markdown.
    sections: [{ _id: false, name: String, minutes: Number, text: String }],
  },
  { collection: 'learn_sessions' }
);
sessionSchema.index({ course: 1, week: 1, day: 1 }, { unique: true });

const progressSchema = new Schema(
  {
    owner: { type: String, required: true },
    course: { type: String, required: true },
    week: { type: Number, required: true },
    day: { type: Number, required: true },
    done: { type: Boolean, default: false },
    doneAt: Date,
    notes: { type: String, default: '', maxlength: 20000 },
    blocks: { type: [Boolean], default: [] },
    // Set when this session was pulled forward into an earlier day ("combine with next topic").
    combinedWith: { type: { week: Number, day: Number }, default: undefined, _id: false },
  },
  { timestamps: true, collection: 'learn_progress' }
);
progressSchema.index({ owner: 1, course: 1, week: 1, day: 1 }, { unique: true });

const milestoneSchema = new Schema(
  {
    owner: { type: String, required: true },
    course: { type: String, required: true },
    stage: { type: Number, required: true },
    done: { type: Boolean, default: false },
    doneAt: Date,
  },
  { collection: 'learn_milestones' }
);
milestoneSchema.index({ owner: 1, course: 1, stage: 1 }, { unique: true });

export const LearnCourse = mongoose.model('LearnCourse', courseSchema);
export const LearnStage = mongoose.model('LearnStage', stageSchema);
export const LearnWeek = mongoose.model('LearnWeek', weekSchema);
export const LearnSession = mongoose.model('LearnSession', sessionSchema);
// Per-learner course settings (their own minutes per day).
const prefSchema = new Schema(
  {
    owner: { type: String, required: true },
    course: { type: String, required: true },
    minutesPerDay: { type: Number, min: 15, max: 600 },
  },
  { timestamps: true, collection: 'learn_prefs' }
);
prefSchema.index({ owner: 1, course: 1 }, { unique: true });

export const LearnPref = mongoose.model('LearnPref', prefSchema);
export const LearnProgress = mongoose.model('LearnProgress', progressSchema);
export const LearnMilestone = mongoose.model('LearnMilestone', milestoneSchema);
