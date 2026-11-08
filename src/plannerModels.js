import mongoose from 'mongoose';
import { AREAS, DATE_RE, DEFAULT_SETTINGS, TIME_RE } from './plannerCore.js';

// Personal planner: free time outside office and sleep. Everything here is per user (owner = email).
const { Schema, model } = mongoose;

const owner = { type: String, required: true, index: true };
const time = { type: String, match: TIME_RE, required: true };
const hideOwner = {
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.owner;
    return ret;
  },
};

const span = new Schema({ start: time, end: time }, { _id: false });

const settingsSchema = new Schema(
  {
    owner: { type: String, required: true, unique: true },
    sleep: { type: span, required: true },
    office: { type: [{ type: span, default: null }], validate: (v) => v.length === 7 }, // Monday first
    bufferMinutes: { type: Number, min: 0, max: 180, default: 30 },
    minWindow: { type: Number, min: 5, max: 120, default: 15 },
    weights: Object.fromEntries(AREAS.map((a) => [a, { type: Number, min: 0, max: 100, default: DEFAULT_SETTINGS.weights[a] }])),
    reminder: {
      enabled: { type: Boolean, default: false },
      time: { type: String, match: TIME_RE, default: '07:30' },
      tz: { type: String, default: 'UTC' },
      lastSentOn: { type: String, match: DATE_RE, default: null },
    },
  },
  { timestamps: true }
);
settingsSchema.set('toJSON', hideOwner);

const itemSchema = new Schema(
  {
    owner,
    area: { type: String, enum: AREAS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    minutes: { type: Number, min: 5, max: 600, required: true },
    priority: { type: Number, min: 1, max: 3, default: 2 }, // 1 = high
    dueDate: { type: String, match: DATE_RE, default: null },
    project: { type: String, trim: true, maxlength: 100, default: '' },
    repeat: { type: String, enum: ['none', 'daily', 'weekly'], default: 'none' },
    days: [{ type: Number, min: 0, max: 6 }], // weekly: 0 = Monday
    active: { type: Boolean, default: true },
    completedAt: { type: Date, default: null }, // one-off items only
  },
  { timestamps: true }
);
itemSchema.set('toJSON', hideOwner);

// Done / skipped for a day. `ref` is a candidate key: item:<id>, learn:<course>:<w>-<d>, topic:…, cert:…
const logSchema = new Schema(
  {
    owner,
    date: { type: String, match: DATE_RE, required: true },
    ref: { type: String, required: true, maxlength: 200 },
    area: { type: String, enum: AREAS, required: true },
    title: { type: String, default: '' },
    minutes: { type: Number, min: 0, max: 600, default: 0 },
    status: { type: String, enum: ['done', 'skipped'], required: true },
  },
  { timestamps: true }
);
logSchema.index({ owner: 1, date: 1, ref: 1 }, { unique: true });
logSchema.set('toJSON', hideOwner);

// One-off busy time for a date (appointments, plans).
const daySchema = new Schema(
  {
    owner,
    date: { type: String, match: DATE_RE, required: true },
    busy: [new Schema({ start: time, end: time, label: { type: String, maxlength: 100, default: '' } }, { _id: false })],
  },
  { timestamps: true }
);
daySchema.index({ owner: 1, date: 1 }, { unique: true });
daySchema.set('toJSON', hideOwner);

// One Web Push subscription per browser/device that turned reminders on.
const pushSchema = new Schema(
  {
    owner,
    endpoint: { type: String, required: true, unique: true, maxlength: 1000 },
    keys: { p256dh: { type: String, required: true, maxlength: 200 }, auth: { type: String, required: true, maxlength: 100 } },
    device: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);
pushSchema.set('toJSON', hideOwner);

export const PushSubscription = model('PushSubscription', pushSchema);
export const PlannerSettings = model('PlannerSettings', settingsSchema);
export const PlanItem = model('PlanItem', itemSchema);
export const PlanLog = model('PlanLog', logSchema);
export const PlanDay = model('PlanDay', daySchema);
