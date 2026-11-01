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

/* ---------- Wealth management (web only; every record belongs to one signed-in account) ---------- */

// Amounts are stored in each record's own currency; the page converts with the owner's rates.
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const owner = { type: String, required: true, index: true }; // Google email
const currency = { type: String, match: CURRENCY_RE, default: 'AED' };
const money = { type: Number, min: 0, default: 0 };
const rate = { type: Number, min: 0, max: 100, default: 0 }; // % per year
const optionalDate = { type: String, match: DATE_RE, default: null };
// Owner is never sent back to the browser.
const hideOwner = {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    delete ret.owner;
    return ret;
  },
};

export const ASSET_TYPES = ['bank', 'fixed_deposit', 'stock', 'mutual_fund', 'gold', 'real_estate', 'other'];
// Money moved into (contribution) or out of (withdrawal) an investment after it was opened.
const flowSchema = new Schema({
  date: { type: String, match: DATE_RE, required: true },
  kind: { type: String, enum: ['contribution', 'withdrawal'], required: true },
  amount: { ...money, required: true },
  grams: { type: Number, min: 0, default: 0 }, // gold / metal: weight added or taken out
  growth: { type: Number, min: -100, max: 1000, default: 0 }, // real estate: % this contribution raised the value
  note: { type: String, default: '', maxlength: 200 },
});
const assetSchema = new Schema(
  {
    owner,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: ASSET_TYPES, default: 'bank' },
    currency,
    principal: money, // amount first put in
    currentValue: money, // ignored for fixed deposits: their value accrues from principal and rate
    interestRate: rate,
    compounding: { type: String, enum: ['monthly', 'quarterly', 'yearly', 'simple'], default: 'quarterly' },
    startDate: optionalDate,
    maturityDate: optionalDate,
    flows: [flowSchema],
    grams: { type: Number, min: 0, default: 0 }, // gold / metal: weight first bought
    purity: { type: String, enum: ['24K', '22K'], default: '24K' }, // gold: valued at the live rate for this purity
    // Money set aside for an upcoming bill: shown, but not counted in net worth or the emergency fund.
    reserved: { type: Boolean, default: false },
    // Part of the balance set aside for a bill (e.g. rent), left out of net worth like `reserved`.
    reservedAmount: { ...money },
    // Bank accounts: amount always on hold; the month's fixed expenses paid from the account are added to it.
    holdAmount: { ...money },
    // Bank accounts: `currentValue` is the balance at the start of this month; from then on the
    // page keeps it up to date from the income, expenses and transfers linked to the account.
    balanceMonth: { type: String, default: '', match: /^$|^\d{4}-(0[1-9]|1[0-2])$/ },
    // Bank accounts: `currentValue` is the opening balance on this date; imported statement lines
    // from this date on (all of them when empty) move the balance.
    openingDate: optionalDate,
    // Latest imported statement: its last date and closing balance (shown with the account).
    statementTo: { type: String, default: '' },
    statementBalance: { type: Number, default: null },
    notes: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true }
);
assetSchema.set('toJSON', hideOwner);

export const LIABILITY_TYPES = ['personal_loan', 'car_loan', 'home_loan', 'credit_card', 'installment', 'other'];
const liabilitySchema = new Schema(
  {
    owner,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: LIABILITY_TYPES, default: 'personal_loan' },
    currency,
    outstanding: money,
    interestRate: rate,
    emi: money,
    remainingMonths: { type: Number, min: 0, default: null },
    nextPaymentDate: optionalDate,
    accountId: { type: String, default: '' }, // bank asset the EMI is paid from
    // Credit cards: `outstanding` is the opening outstanding on this date; imported card lines from
    // this date on (all of them when empty) move it: spends add, payments and refunds take off.
    openingDate: optionalDate,
    // Latest imported statement: its last date and closing balance (shown with the account).
    statementTo: { type: String, default: '' },
    statementBalance: { type: Number, default: null },
    notes: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true }
);
liabilitySchema.set('toJSON', hideOwner);

// Personal money owed between you and someone else (not a bank loan): `lent` is owed to you
// and counts as an asset; `borrowed` is owed by you and counts as a liability.
const repaymentSchema = new Schema({
  date: { type: String, match: DATE_RE, required: true },
  amount: { ...money, required: true },
  note: { type: String, default: '', maxlength: 200 },
});
const debtSchema = new Schema(
  {
    owner,
    direction: { type: String, enum: ['lent', 'borrowed'], required: true },
    person: { type: String, required: true, trim: true, maxlength: 120 },
    currency,
    amount: { ...money, required: true }, // original amount
    date: optionalDate, // when the money changed hands
    dueDate: optionalDate,
    repayments: [repaymentSchema],
    note: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true }
);
debtSchema.set('toJSON', hideOwner);

// One income or expense line in a month. Moving money into an asset is not an expense
// (see asset flows), so savings and net worth never count it twice.
const cashEntrySchema = new Schema(
  {
    owner,
    month: { type: String, match: MONTH_RE, required: true },
    kind: { type: String, enum: ['income', 'expense'], required: true },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    amount: { ...money, required: true },
    currency,
    recurring: { type: Boolean, default: false },
    checklist: { type: Boolean, default: false }, // listed in the monthly expense checklist
    accountId: { type: String, default: '' }, // bank asset it is paid into / out of
    note: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);
cashEntrySchema.index({ owner: 1, month: 1 });
cashEntrySchema.set('toJSON', hideOwner);

// Fixed monthly income or expense (salary, rent, subscriptions). It counts in every month
// from startMonth through endMonth (open-ended when empty) without adding entries each month.
const fixedItemSchema = new Schema(
  {
    owner,
    kind: { type: String, enum: ['income', 'expense'], required: true },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    amount: { ...money, required: true },
    // Set when the amount varies (utilities): `amount` is the low end, totals use the midpoint.
    amountMax: { type: Number, min: 0, default: null },
    currency,
    // How often it is paid, in months (1 monthly, 3 quarterly, 12 yearly). `amount` is per payment;
    // monthly totals spread it evenly across the months in between.
    every: { type: Number, enum: [1, 2, 3, 6, 12], default: 1 },
    // false: count the whole payment only in the months it is paid (startMonth, then every `every` months).
    spread: { type: Boolean, default: true },
    accountId: { type: String, default: '' }, // bank asset it is paid into / out of
    startMonth: { type: String, match: MONTH_RE, required: true },
    endMonth: { type: String, default: '', match: /^$|^\d{4}-(0[1-9]|1[0-2])$/ },
    note: { type: String, default: '', maxlength: 200 },
    checklist: { type: Boolean, default: false }, // listed in the monthly expense checklist
    checkedMonths: { type: [{ type: String, match: MONTH_RE }], default: [] }, // months ticked off as paid
  },
  { timestamps: true }
);
fixedItemSchema.set('toJSON', hideOwner);

// Money moved between two bank accounts. Not income or an expense: it only changes the two balances.
// One-off in `startMonth`, or every month from startMonth through endMonth when `monthly`.
const transferSchema = new Schema(
  {
    owner,
    fromId: { type: String, required: true },
    toId: { type: String, required: true },
    amount: { ...money, required: true },
    currency,
    monthly: { type: Boolean, default: false },
    startMonth: { type: String, match: MONTH_RE, required: true },
    endMonth: { type: String, default: '', match: /^$|^\d{4}-(0[1-9]|1[0-2])$/ },
    note: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);
transferSchema.set('toJSON', hideOwner);

// One line of an imported bank or credit card statement. `account` is "asset:<id>" for a bank
// account or "liability:<id>" for a credit card. `category` is its tag; tags in EXCLUDED_TAGS
// (transfers, card payments) are not income or expenses.
const transactionSchema = new Schema(
  {
    owner,
    account: { type: String, required: true, match: /^(asset|liability):.+$/ },
    date: { type: String, match: DATE_RE, required: true },
    description: { type: String, required: true, maxlength: 200 },
    amount: { ...money, required: true },
    currency,
    direction: { type: String, enum: ['in', 'out'], required: true },
    category: { type: String, default: '', maxlength: 60 },
    note: { type: String, default: '', maxlength: 200 },
    // Bank debit paid out of the account's hold (e.g. the rent going out): it reduces the hold that month.
    fromHold: { type: Boolean, default: false },
    // The fixed items or loans this line pays ('fixed:<id>' / 'liability:<id>'): it replaces their planned amounts that month.
    linkTo: { type: [{ type: String, maxlength: 80 }], default: [] },
    source: { type: String, enum: ['upload', 'gmail', 'manual'], default: 'upload' },
  },
  { timestamps: true }
);
transactionSchema.set('toJSON', hideOwner);

// Gmail: statements for `account` arrive as PDF attachments on mails with this subject.
const mailSourceSchema = new Schema(
  {
    owner,
    account: { type: String, required: true, match: /^(asset|liability):.+$/ },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    sender: { type: String, default: '', trim: true, maxlength: 200 },
    password: { type: String, default: '', maxlength: 100 }, // PDF password (stored encrypted)
    lastSync: { type: Date, default: null },
    lastResult: { type: String, default: '', maxlength: 300 },
    seen: { type: [String], default: [] }, // Gmail message ids already imported
  },
  { timestamps: true }
);
mailSourceSchema.set('toJSON', hideOwner);

// Auto-tagging: a merchant (see merchantKey) always gets this category.
const tagRuleSchema = new Schema(
  {
    owner,
    key: { type: String, required: true, maxlength: 100 },
    category: { type: String, required: true, maxlength: 60 },
  },
  { timestamps: true }
);
tagRuleSchema.set('toJSON', hideOwner);

// Monthly spending limit for one expense category.
const budgetSchema = new Schema(
  {
    owner,
    category: { type: String, required: true, trim: true, maxlength: 60 },
    amount: { ...money, required: true },
    currency,
  },
  { timestamps: true }
);
budgetSchema.index({ owner: 1, category: 1 }, { unique: true });
budgetSchema.set('toJSON', hideOwner);

export const GOAL_TYPES = ['emergency_fund', 'property', 'education', 'retirement', 'debt_repayment', 'net_worth', 'other'];
const goalSchema = new Schema(
  {
    owner,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: GOAL_TYPES, default: 'other' },
    currency,
    targetAmount: { ...money, required: true },
    currentAmount: money, // ignored for net_worth goals, which track actual net worth
    monthlyContribution: money,
    targetDate: optionalDate,
  },
  { timestamps: true }
);
goalSchema.set('toJSON', hideOwner);

// Net worth at the end of a month, recorded by the page so growth can be charted over time.
const snapshotSchema = new Schema(
  {
    owner,
    month: { type: String, match: MONTH_RE, required: true },
    currency,
    assets: { type: Number, default: 0 },
    liabilities: { type: Number, default: 0 },
  },
  { timestamps: true }
);
snapshotSchema.index({ owner: 1, month: 1 }, { unique: true });
snapshotSchema.set('toJSON', hideOwner);

const scenario = (expectedReturn) => ({ expectedReturn: { ...rate, default: expectedReturn } });
// Per-account preferences: reporting currency, exchange rates and forecast assumptions.
const wealthSettingsSchema = new Schema(
  {
    owner: { type: String, required: true, unique: true },
    baseCurrency: currency,
    // Value of one unit of each currency in AED (AED itself is always 1).
    rates: { type: Map, of: { type: Number, min: 0 }, default: () => ({ INR: 0.044, USD: 3.6725, EUR: 3.95, GBP: 4.65, SAR: 0.979 }) },
    scenarios: {
      conservative: scenario(5),
      moderate: scenario(8),
      optimistic: scenario(11),
    },
    inflation: { ...rate, default: 4 },
    savingsGrowth: { ...rate, default: 3 }, // yearly rise in monthly savings
    withdrawalRate: { type: Number, min: 1, max: 10, default: 4 }, // safe withdrawal rate for financial independence
    forecastYears: { type: Number, min: 1, max: 50, default: 20 },
    excludeHomeFromFi: { type: Boolean, default: true }, // real estate is not counted as investable
    autoRates: { type: Boolean, default: false }, // use the daily market rates (MarketRates) instead of `rates`
    // The user's own category lists; empty means the built-in defaults.
    incomeCategories: { type: [{ type: String, trim: true, maxlength: 60 }], default: [] },
    expenseCategories: { type: [{ type: String, trim: true, maxlength: 60 }], default: [] },
  },
  { timestamps: true }
);
wealthSettingsSchema.set('toJSON', hideOwner);

/* ---------- Learning: Coursera courses and the daily plan (web only; one signed-in account each) ---------- */

// One learning item (video, reading, quiz…). `doneOn` is the local date it was finished, so the
// page can count minutes per day without a separate log.
const learningItemSchema = new Schema(
  {
    key: { type: String, required: true }, // Coursera item id, or m<module>-<n> for manual courses
    name: { type: String, default: '', maxlength: 300 },
    type: { type: String, default: '', maxlength: 40 },
    minutes: { type: Number, min: 0, max: 1440, default: 0 },
    optional: { type: Boolean, default: false },
    done: { type: Boolean, default: false },
    doneOn: optionalDate,
  },
  { _id: false }
);
const learningModuleSchema = new Schema(
  {
    key: { type: String, required: true },
    name: { type: String, default: '', maxlength: 300 },
    items: [learningItemSchema],
  },
  { _id: false }
);
const learningCourseSchema = new Schema(
  {
    owner,
    source: { type: String, enum: ['coursera', 'manual'], default: 'manual' },
    courseraId: { type: String, default: null }, // set for synced courses; the sync matches on it
    slug: { type: String, default: '' },
    name: { type: String, required: true, trim: true, maxlength: 300 },
    partner: { type: String, default: '', maxlength: 200 },
    url: { type: String, default: '', maxlength: 500 },
    photoUrl: { type: String, default: '', maxlength: 500 },
    modules: [learningModuleSchema],
    // Set in the app, kept across syncs.
    phaseId: { type: Schema.Types.ObjectId, ref: 'Phase', default: null },
    topicId: { type: Schema.Types.ObjectId, default: null },
    targetDate: optionalDate,
    priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
    archived: { type: Boolean, default: false },
    syncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
learningCourseSchema.index({ owner: 1, courseraId: 1 });
learningCourseSchema.set('toJSON', hideOwner);

const learningSettingsSchema = new Schema(
  {
    owner: { ...owner, unique: true },
    dailyMinutes: { type: Number, min: 10, max: 600, default: 60 },
    studyDays: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0 = Sunday, as Date.getDay()
    lastSyncAt: { type: Date, default: null },
  },
  { timestamps: true }
);
learningSettingsSchema.set('toJSON', hideOwner);

// Notes taken while learning (Chrome extension or the Learning tab): a topic with its points.
// `courseSlug` comes from the Coursera page the note was taken on and links it to a synced course.
const learningPointSchema = new Schema(
  { text: { type: String, required: true, trim: true, maxlength: 2000 } },
  { timestamps: true }
);
const learningNoteSchema = new Schema(
  {
    owner,
    topic: { type: String, required: true, trim: true, maxlength: 200 },
    points: [learningPointSchema],
    courseSlug: { type: String, default: '', maxlength: 200 },
    pageUrl: { type: String, default: '', maxlength: 1000 },
    pageTitle: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true }
);
learningNoteSchema.index({ owner: 1, updatedAt: -1 });
learningNoteSchema.set('toJSON', hideOwner);

export const LearningCourse = model('LearningCourse', learningCourseSchema);
export const LearningNote = model('LearningNote', learningNoteSchema);
export const LearningSettings = model('LearningSettings', learningSettingsSchema);

export const Asset = model('Asset', assetSchema);
export const Liability = model('Liability', liabilitySchema);
export const CashEntry = model('CashEntry', cashEntrySchema);
export const FixedItem = model('FixedItem', fixedItemSchema);
export const Transfer = model('Transfer', transferSchema);
export const Transaction = model('Transaction', transactionSchema);
export const MailSource = model('MailSource', mailSourceSchema);
export const TagRule = model('TagRule', tagRuleSchema);
export const Debt = model('Debt', debtSchema);
export const Budget = model('Budget', budgetSchema);
export const Goal = model('Goal', goalSchema);
export const WealthSnapshot = model('WealthSnapshot', snapshotSchema);
export const WealthSettings = model('WealthSettings', wealthSettingsSchema);

// Market exchange rates shared by every account (public data, not encrypted): AED per 1 unit.
// One document, _id 'fx', refreshed daily at 18:00 UAE time.
const marketRatesSchema = new Schema({
  _id: { type: String },
  rates: { type: Schema.Types.Mixed, default: {} },
  updatedAt: String, // when the provider last updated them
  source: String,
  fetchedAt: Date, // when this server fetched them
});
export const MarketRates = model('MarketRates', marketRatesSchema);

// Every wealth record, encrypted with the account's vault key. The models above are used only to
// validate a record before it is encrypted; `kind` is the collection name, `key` the snapshot month.
const wealthRecordSchema = new Schema(
  {
    owner: { type: String, required: true },
    kind: { type: String, required: true },
    key: { type: String, default: '' },
    data: { type: String, required: true }, // ciphertext
  },
  { timestamps: true }
);
wealthRecordSchema.index({ owner: 1, kind: 1, key: 1 });
export const WealthRecord = model('WealthRecord', wealthRecordSchema);

export const VaultMeta = model('VaultMeta', vaultMetaSchema);
export const VaultEntry = model('VaultEntry', vaultEntrySchema);

export const Category = model('Category', categorySchema);
export const Task = model('Task', taskSchema);
export const Phase = model('Phase', phaseSchema);
export const Certification = model('Certification', certificationSchema);
export const Profile = model('Profile', profileSchema);
export const Note = model('Note', noteSchema);
