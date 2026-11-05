import { Router } from 'express';
import {
  Asset, Budget, CashEntry, Debt, FixedItem, Goal, Liability, MailSource, MarketRates, TagRule, Transaction, Transfer, VaultMeta, WealthRecord, WealthSettings, WealthSnapshot,
} from './models.js';
import { StatementError, autoTag, matchManual, merchantKey, parseStatement, txnHash } from './statements.js';
import { gmailRoutes } from './gmail.js';
import { openJson, requireUnlocked, sealJson } from './vault.js';

// Wealth management API (web only). Mounted behind requireAuth; every record is scoped to
// req.user.email, so one allowed account never sees another's finances.
//
// Everything is stored encrypted with the account's vault key (see vault.js): reading or writing
// needs the vault unlocked with the PIN (x-vault-unlock header), otherwise 423. The mongoose
// models only validate a record; the database holds WealthRecord ciphertext.

const router = Router();

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const SCOPE = 'wealth';

const ASSET_FIELDS = ['name', 'type', 'currency', 'principal', 'currentValue', 'interestRate', 'compounding', 'startDate', 'maturityDate', 'flows', 'grams', 'purity', 'reserved', 'reservedAmount', 'holdAmount', 'balanceMonth', 'openingDate', 'statementTo', 'statementBalance', 'notes'];
const COLLECTIONS = {
  assets: { Model: Asset, fields: ASSET_FIELDS, what: 'Asset' },
  liabilities: {
    Model: Liability,
    fields: ['name', 'type', 'currency', 'outstanding', 'interestRate', 'emi', 'remainingMonths', 'nextPaymentDate', 'accountId', 'openingDate', 'statementTo', 'statementBalance', 'notes'],
    what: 'Liability',
  },
  debts: { Model: Debt, fields: ['direction', 'person', 'currency', 'amount', 'date', 'dueDate', 'repayments', 'note'], what: 'Debt' },
  entries: { Model: CashEntry, fields: ['month', 'kind', 'category', 'amount', 'currency', 'recurring', 'checklist', 'accountId', 'note'], what: 'Entry' },
  fixed: { Model: FixedItem, fields: ['kind', 'category', 'amount', 'amountMax', 'currency', 'every', 'spread', 'accountId', 'startMonth', 'endMonth', 'note', 'checklist', 'checkedMonths'], what: 'Fixed item' },
  transfers: { Model: Transfer, fields: ['fromId', 'toId', 'amount', 'currency', 'monthly', 'startMonth', 'endMonth', 'note'], what: 'Transfer' },
  budgets: { Model: Budget, fields: ['category', 'amount', 'currency'], what: 'Budget' },
  transactions: { Model: Transaction, fields: ['date', 'description', 'amount', 'direction', 'category', 'note', 'fromHold', 'linkTo'], what: 'Transaction' },
  sources: { Model: MailSource, fields: ['account', 'subject', 'sender', 'password'], what: 'Statement email' },
  rules: { Model: TagRule, fields: ['key', 'category'], what: 'Tag rule' },
  goals: {
    Model: Goal,
    fields: ['name', 'type', 'currency', 'targetAmount', 'currentAmount', 'monthlyContribution', 'targetDate'],
    what: 'Goal',
  },
};
const SETTINGS_FIELDS = [
  'baseCurrency', 'rates', 'scenarios', 'inflation', 'savingsGrowth', 'withdrawalRate', 'forecastYears', 'excludeHomeFromFi', 'autoRates',
  'incomeCategories', 'expenseCategories',
];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const strip = (plain) => {
  delete plain.id;
  delete plain.createdAt;
  delete plain.updatedAt;
  return plain;
};

// Runs the model's validation (and defaults) and returns the plain JSON the page works with.
async function validated(Model, data, owner) {
  const doc = new Model({ ...data, owner });
  try {
    await doc.validate();
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  return strip(doc.toJSON());
}

const reveal = (vault, rec) => ({
  ...openJson(vault.dek, vault.owner, SCOPE, rec.data),
  id: rec.id,
  createdAt: rec.createdAt,
  updatedAt: rec.updatedAt,
});

const store = (vault, kind, plain, extra = {}) =>
  WealthRecord.create({ owner: vault.owner, kind, data: sealJson(vault.dek, vault.owner, SCOPE, plain), ...extra });

const reseal = async (vault, rec, plain) => {
  rec.data = sealJson(vault.dek, vault.owner, SCOPE, plain);
  await rec.save();
  return reveal(vault, rec);
};

// One-time move of records saved before encryption: encrypt them, then delete the plaintext.
const LEGACY = [
  ['assets', Asset], ['liabilities', Liability], ['debts', Debt], ['entries', CashEntry], ['fixed', FixedItem],
  ['budgets', Budget], ['goals', Goal], ['settings', WealthSettings], ['snapshots', WealthSnapshot],
];
async function migrateLegacy(vault) {
  for (const [kind, Model] of LEGACY) {
    for (const doc of await Model.find({ owner: vault.owner })) {
      const key = kind === 'snapshots' ? doc.month : '';
      await store(vault, kind, strip(doc.toJSON()), { _id: doc._id, key, createdAt: doc.createdAt });
      await Model.deleteOne({ _id: doc._id });
    }
  }
}

// Wealth needs the vault PIN: 409 tells the page to offer creating it.
router.use(
  ah(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!(await VaultMeta.exists({ owner: req.user.email }))) {
      return res.status(409).json({ error: 'Create your vault PIN first.', needsSetup: true });
    }
    next();
  })
);
router.use(requireUnlocked);

async function settingsFor(vault) {
  let rec = await WealthRecord.findOne({ owner: vault.owner, kind: 'settings' });
  if (!rec) rec = await store(vault, 'settings', await validated(WealthSettings, {}, vault.owner));
  return { rec, settings: reveal(vault, rec) };
}

// Live gold spot price (USD per troy ounce, no key needed), cached for 1 minute and returned as
// AED per gram of 24K gold. AED is pegged at 3.6725 per USD. null when the feed is unreachable.
const OZ_GRAMS = 31.1034768;
let goldCache = null;
let goldError = null; // last failure, shown by /gold-price so production problems are visible
async function goldPrice() {
  if (goldCache && Date.now() - goldCache.at < 60 * 1000) return goldCache.value;
  try {
    const r = await fetch('https://api.gold-api.com/price/XAU', {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', 'User-Agent': 'task-assistant/1.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!(j.price > 0)) throw new Error('no price in response');
    const value = { aedPerGram24: (j.price * 3.6725) / OZ_GRAMS, updatedAt: j.updatedAt };
    goldCache = { at: Date.now(), value };
    return value;
  } catch (e) {
    goldError = `${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`;
    console.error('[gold-price] fetch failed:', goldError);
    return goldCache?.value ?? null;
  }
}

const byCreated = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

// Everything the page needs in one call, decrypted.
// Market exchange rates as AED per 1 unit of each currency (the shape settings.rates uses).
// ExchangeRate-API's open feed first, the fawazahmed0 CDN feed as a backup. Fetched daily at
// 18:00 UAE time (UTC+4, no DST) and stored in MarketRates, so every account and restart shares them.
async function fetchFx() {
  const opts = { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': 'task-assistant/1.0' } };
  const sources = [
    async () => {
      const j = await (await fetch('https://open.er-api.com/v6/latest/AED', opts)).json();
      if (j.result !== 'success') throw new Error(j['error-type'] || 'bad response');
      return { perAed: j.rates, updatedAt: new Date(j.time_last_update_unix * 1000).toISOString(), source: 'ExchangeRate-API' };
    },
    async () => {
      const j = await (await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/aed.json', opts)).json();
      if (!j.aed) throw new Error('bad response');
      const perAed = Object.fromEntries(Object.entries(j.aed).map(([c, v]) => [c.toUpperCase(), v]));
      return { perAed, updatedAt: j.date, source: 'fawazahmed0 currency-api' };
    },
  ];
  const errors = [];
  for (const src of sources) {
    try {
      const { perAed, updatedAt, source } = await src();
      const rates = {};
      for (const [c, v] of Object.entries(perAed)) if (/^[A-Z]{3}$/.test(c) && v > 0 && c !== 'AED') rates[c] = 1 / v;
      return { rates, updatedAt, source };
    } catch (e) {
      errors.push(`${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`);
    }
  }
  throw new HttpError(502, `Exchange rates unavailable: ${errors.join(' | ')}`);
}

const UAE_OFFSET_H = 4;
const FX_HOUR = 18;
// The most recent 18:00 UAE time at or before `now`.
function lastFxRun(now = new Date()) {
  const run = new Date(now);
  run.setUTCHours(FX_HOUR - UAE_OFFSET_H, 0, 0, 0);
  if (run > now) run.setUTCDate(run.getUTCDate() - 1);
  return run;
}

async function refreshMarketRates() {
  try {
    const value = await fetchFx();
    await MarketRates.findByIdAndUpdate('fx', { ...value, fetchedAt: new Date() }, { upsert: true });
    console.log(`[fx-rates] updated from ${value.source}`);
    return value;
  } catch (e) {
    console.error('[fx-rates]', e.message);
    return null;
  }
}

// Stored rates; refetched first when they predate the latest 18:00 run (e.g. the host slept through it).
let fxRefreshing = null;
async function marketRates() {
  let doc = await MarketRates.findById('fx').lean();
  if (!doc || !doc.fetchedAt || doc.fetchedAt < lastFxRun()) {
    fxRefreshing ??= refreshMarketRates().finally(() => (fxRefreshing = null));
    await fxRefreshing;
    doc = (await MarketRates.findById('fx').lean()) || doc;
  }
  return doc ? { rates: doc.rates, updatedAt: doc.updatedAt, source: doc.source, fetchedAt: doc.fetchedAt } : null;
}

// Daily timer for 18:00 UAE time; call once after the database connects.
export function startFxSchedule() {
  const next = () => lastFxRun().getTime() + 24 * 60 * 60 * 1000 - Date.now();
  const tick = async () => {
    await refreshMarketRates();
    setTimeout(tick, next());
  };
  setTimeout(tick, next());
  marketRates().catch(() => {}); // catch up now if today's run was missed
}

router.get(
  '/fx-rates',
  ah(async (_req, res) => {
    const value = await refreshMarketRates();
    if (!value) throw new HttpError(502, 'Exchange rates unavailable right now; see the server log.');
    res.json(await marketRates());
  })
);

// Live gold rate on its own, so the asset form can refresh it while open.
router.get(
  '/gold-price',
  ah(async (_req, res) => {
    const price = await goldPrice();
    res.json(price ?? { error: goldError || 'Gold rate unavailable' });
  })
);

router.get(
  '/',
  ah(async (req, res) => {
    const vault = req.vault;
    await migrateLegacy(vault);
    const { settings } = await settingsFor(vault);
    const out = { settings, assets: [], liabilities: [], debts: [], entries: [], fixed: [], transfers: [], transactions: [], sources: [], rules: [], budgets: [], goals: [], snapshots: [] };
    for (const rec of await WealthRecord.find({ owner: vault.owner, kind: { $ne: 'settings' } })) out[rec.kind]?.push(reveal(vault, rec));
    for (const k of ['assets', 'liabilities', 'debts', 'goals']) out[k].sort(byCreated);
    out.entries.sort((a, b) => b.month.localeCompare(a.month) || byCreated(a, b));
    out.fixed.sort((a, b) => a.kind.localeCompare(b.kind) || byCreated(a, b));
    out.budgets.sort((a, b) => a.category.localeCompare(b.category));
    out.snapshots.sort((a, b) => a.month.localeCompare(b.month));
    out.transactions.sort((a, b) => b.date.localeCompare(a.date) || byCreated(a, b));
    out.goldPrice = await goldPrice();
    out.marketRates = await marketRates().catch(() => null);
    res.json(out);
  })
);

router.put(
  '/settings',
  ah(async (req, res) => {
    const vault = req.vault;
    const { rec, settings } = await settingsFor(vault);
    const data = pick(req.body, SETTINGS_FIELDS);
    if (data.rates) data.rates = { ...data.rates, AED: 1 };
    res.json(await reseal(vault, rec, await validated(WealthSettings, { ...strip(settings), ...data }, vault.owner)));
  })
);

// The page records this month's totals (in its reporting currency) whenever they change.
router.put(
  '/snapshots/:month',
  ah(async (req, res) => {
    const vault = req.vault;
    const month = req.params.month;
    const plain = await validated(WealthSnapshot, { ...pick(req.body, ['currency', 'assets', 'liabilities']), month }, vault.owner);
    const rec = await WealthRecord.findOne({ owner: vault.owner, kind: 'snapshots', key: month });
    res.json(rec ? await reseal(vault, rec, plain) : reveal(vault, await store(vault, 'snapshots', plain, { key: month })));
  })
);


/* ---------- Statements and transactions ---------- */

// "asset:<id>" (bank account) or "liability:<id>" (credit card) → its record, or 404.
async function accountRecord(vault, account) {
  const [type, id] = String(account || '').split(':');
  const kind = type === 'asset' ? 'assets' : type === 'liability' ? 'liabilities' : null;
  const rec = kind && (await WealthRecord.findOne({ _id: id, owner: vault.owner, kind }).catch(() => null));
  if (!rec) throw new HttpError(404, 'Account not found');
  return { rec, kind, plain: reveal(vault, rec) };
}

async function rulesFor(vault) {
  const recs = await WealthRecord.find({ owner: vault.owner, kind: 'rules' });
  return new Map(recs.map((r) => reveal(vault, r)).map((r) => [r.key, r.category]));
}

// Built-in category lists, used until the user sets their own. Same as web/src/views/wealth/calc.js.
const INCOME_CATEGORIES = ['Salary', 'Bonus', 'Business', 'Rental', 'Interest & dividends', 'Other income'];
const EXPENSE_CATEGORIES = ['Housing', 'Utilities', 'Groceries', 'Dining', 'Transport', 'Insurance', 'Health', 'Education', 'Shopping', 'Travel', 'Entertainment', 'Family support', 'Loan EMI', 'Other'];

// Lines added by hand to an account that no statement line has replaced yet (imported lines have a key).
async function openManualLines(vault, account) {
  const recs = await WealthRecord.find({ owner: vault.owner, kind: 'transactions', key: '' });
  return recs.map((r) => reveal(vault, r)).filter((t) => t.account === account && t.source === 'manual');
}

// Marks each parsed line as a duplicate (already imported for this account), maps it to the line added
// by hand that it replaces, and gives it a starting tag.
async function previewLines(vault, account, lines, isCard) {
  const keys = lines.map((t) => txnHash(account, t));
  const known = new Set((await WealthRecord.find({ owner: vault.owner, kind: 'transactions', key: { $in: keys } }, { key: 1 })).map((r) => r.key));
  const rules = await rulesFor(vault);
  const { settings } = await settingsFor(vault);
  const categories = {
    income: settings.incomeCategories?.length ? settings.incomeCategories : INCOME_CATEGORIES,
    expense: settings.expenseCategories?.length ? settings.expenseCategories : EXPENSE_CATEGORIES,
  };
  const marked = lines.map((t, i) => ({ ...t, key: keys[i], duplicate: known.has(keys[i]) }));
  const manual = await openManualLines(vault, account);
  const matches = matchManual(marked, manual);
  return marked.map((t, i) => {
    const m = manual.find((x) => x.id === matches[i]);
    const match = m ? { id: m.id, date: m.date, description: m.description, amount: m.amount, category: m.category } : null;
    return { ...t, match, category: t.category ?? (m?.category || autoTag(t, isCard, rules, categories)) };
  });
}

// Saves the new lines of a statement for an account; a newer statement also updates its balance.
export async function importStatement(vault, account, { transactions, to, closing }, source) {
  const acct = await accountRecord(vault, account);
  const isCard = acct.kind === 'liabilities';
  const lines = await previewLines(vault, account, transactions, isCard);
  const created = [];
  const matched = [];
  for (const t of lines) {
    if (t.duplicate) continue;
    if (t.match) {
      // The statement line replaces the line added by hand: the statement's date, wording and amount,
      // with its own wording kept as the note, and its key so importing again skips it.
      const rec = await WealthRecord.findOne({ _id: t.match.id, owner: vault.owner, kind: 'transactions' });
      const mine = strip(reveal(vault, rec));
      const merged = { ...mine, date: t.date, description: t.description, amount: t.amount, category: t.category || mine.category, note: mine.note || mine.description, source };
      const plain = await validated(Transaction, merged, vault.owner);
      rec.key = t.key;
      matched.push(await reseal(vault, rec, plain));
      continue;
    }
    const plain = await validated(
      Transaction,
      { account, date: t.date, description: t.description, amount: t.amount, direction: t.direction, category: t.category || '', currency: acct.plain.currency, source },
      vault.owner,
    );
    created.push(reveal(vault, await store(vault, 'transactions', plain, { key: t.key })));
  }
  let updated = null;
  if (closing != null && to && to >= (acct.plain.statementTo || '')) {
    // Shown with the account to compare: its balance itself comes from the opening balance and the lines.
    const patch = { statementTo: to, statementBalance: closing };
    const Model = isCard ? Liability : Asset;
    updated = await reseal(vault, acct.rec, await validated(Model, { ...strip(acct.plain), ...patch }, vault.owner));
  }
  return { created, matched, duplicates: lines.length - created.length - matched.length, account: updated && { kind: acct.kind, item: updated } };
}

const statementError = (e) => {
  if (e instanceof StatementError) throw new HttpError(400, e.message, { needsPassword: !!e.needsPassword });
  throw e;
};

// Reads an uploaded statement PDF: nothing is saved, the page shows the lines to import.
router.post(
  '/statements/parse',
  ah(async (req, res) => {
    const { account, file, password } = req.body || {};
    const acct = await accountRecord(req.vault, account);
    if (typeof file !== 'string' || !file) throw new HttpError(400, 'Choose a PDF file');
    const parsed = await parseStatement(Buffer.from(file, 'base64'), password).catch(statementError);
    const lines = await previewLines(req.vault, account, parsed.transactions, acct.kind === 'liabilities');
    res.json({ ...parsed, transactions: lines });
  })
);

router.post(
  '/transactions/import',
  ah(async (req, res) => {
    const { account, transactions, to, closing } = req.body || {};
    if (!Array.isArray(transactions) || transactions.length > 2000) throw new HttpError(400, 'No transactions to import');
    const lines = transactions.map((t) => ({
      date: String(t.date), description: String(t.description || '').slice(0, 200), amount: Number(t.amount), direction: t.direction, category: String(t.category || ''),
      match: typeof t.match === 'string' ? t.match : null, // what the page showed and the user kept
    }));
    res.json(await importStatement(req.vault, account, { transactions: lines, to, closing: closing == null ? null : Number(closing) }, 'upload'));
  })
);

// A credit or debit added by hand, in the account's currency. Importing a statement later maps it to its line.
router.post(
  '/transactions',
  ah(async (req, res) => {
    const vault = req.vault;
    const acct = await accountRecord(vault, req.body?.account);
    if (!(Number(req.body?.amount) > 0)) throw new HttpError(400, 'Enter an amount above zero');
    const fields = pick(req.body, COLLECTIONS.transactions.fields);
    const plain = await validated(Transaction, { ...fields, account: req.body.account, currency: acct.plain.currency, source: 'manual' }, vault.owner);
    res.status(201).json(reveal(vault, await store(vault, 'transactions', plain)));
  })
);

// Tags one transaction; with `similar`, remembers the merchant's tag and applies it to its other untagged lines.
router.post(
  '/transactions/:id/tag',
  ah(async (req, res) => {
    const vault = req.vault;
    const category = String(req.body?.category || '').trim().slice(0, 60);
    const rec = await WealthRecord.findOne({ _id: req.params.id, owner: vault.owner, kind: 'transactions' }).catch(() => null);
    if (!rec) throw new HttpError(404, 'Transaction not found');
    const plain = strip(reveal(vault, rec));
    const changed = [await reseal(vault, rec, { ...plain, category })];
    if (req.body?.similar && category) {
      const key = merchantKey(plain.description);
      const rules = await WealthRecord.find({ owner: vault.owner, kind: 'rules' });
      const rule = rules.find((r) => reveal(vault, r).key === key);
      if (rule) await reseal(vault, rule, { key, category });
      else await store(vault, 'rules', { key, category });
      for (const r of await WealthRecord.find({ owner: vault.owner, kind: 'transactions', _id: { $ne: rec._id } })) {
        const t = strip(reveal(vault, r));
        if (!t.category && merchantKey(t.description) === key) changed.push(await reseal(vault, r, { ...t, category }));
      }
    }
    res.json(changed);
  })
);

gmailRoutes(router, { ah, HttpError, store, reveal, reseal, strip, validated, importStatement, statementError });

// Generic CRUD for the record collections above.
const collection = (req) => {
  const c = COLLECTIONS[req.params.collection];
  if (!c) throw new HttpError(404, 'Not found');
  return c;
};
const findRecord = async (req, c) => {
  const rec = await WealthRecord.findOne({ _id: req.params.id, owner: req.vault.owner, kind: req.params.collection }).catch(() => null);
  if (!rec) throw new HttpError(404, `${c.what} not found`);
  return rec;
};

router.post(
  '/:collection',
  ah(async (req, res) => {
    const c = collection(req);
    const plain = await validated(c.Model, pick(req.body, c.fields), req.vault.owner);
    res.status(201).json(reveal(req.vault, await store(req.vault, req.params.collection, plain)));
  })
);

router.put(
  '/:collection/:id',
  ah(async (req, res) => {
    const c = collection(req);
    const rec = await findRecord(req, c);
    const current = strip(reveal(req.vault, rec));
    res.json(await reseal(req.vault, rec, await validated(c.Model, { ...current, ...pick(req.body, c.fields) }, req.vault.owner)));
  })
);

router.delete(
  '/:collection/:id',
  ah(async (req, res) => {
    const rec = await findRecord(req, collection(req));
    await rec.deleteOne();
    res.status(204).end();
  })
);

router.use((err, _req, res, next) => (err instanceof HttpError ? res.status(err.status).json({ error: err.message, ...err.extra }) : next(err)));

export default router;
