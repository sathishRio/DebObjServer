import crypto from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/*
 * Bank / credit card statement PDFs → transactions
 * ------------------------------------------------
 * The PDF text is rebuilt into lines (text items on the same baseline, left to right), then every
 * line that starts with a date and ends with an amount becomes a transaction:
 *   "07/10/2026 DUBAI ELECTRICITY DUBAI ARE 387.97"          card purchase (money out)
 *   "07/10/2026 PAYMENT RECEIVED, THANK YOU 2500.00 CR"      CR = money in
 *   "01/11/2026 SALARY ACME 20,000.00 21,000.00"             bank: amount then running balance
 * Bank statements with a balance column tell in / out from how the balance moves.
 */

export class StatementError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

// Text lines of every page, top to bottom, with their cells (x position and text) for column lookups.
async function pdfLines(buffer, password) {
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buffer), password: password || undefined, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') {
      throw new StatementError(password ? 'Wrong statement password' : 'This statement needs a password', { needsPassword: true });
    }
    throw new StatementError('Could not read this PDF');
  }
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    // Top to bottom; an item within 3pt of the current line's baseline joins it (columns in
    // different fonts sit slightly higher or lower on the same row).
    const cells = items
      .filter((it) => it.str?.trim())
      .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str.trim() }))
      .sort((a, b) => b.y - a.y);
    const rows = [];
    for (const c of cells) {
      const row = rows.at(-1);
      if (row && row.y - c.y <= 3) row.cells.push(c);
      else rows.push({ y: c.y, cells: [c] });
    }
    for (const row of rows) {
      const sorted = row.cells.sort((a, b) => a.x - b.x);
      lines.push({ text: sorted.map((c) => c.str).join(' ').replace(/\s+/g, ' '), cells: sorted });
    }
  }
  await doc.destroy();
  return lines;
}

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
// Leading date: 07/10/2026, 07-10-26, 07 Oct 2026, 07-OCT-2026 (day first, as UAE banks print them).
const DATE_RE = /^(\d{1,2})[/\-. ](\d{1,2}|[A-Za-z]{3})[/\-. ](\d{2,4})\b/;
const AMOUNT = String.raw`-?\d{1,3}(?:,\d{3})*(?:\.\d{2})|-?\d+\.\d{2}`;
const TAIL_RE = new RegExp(String.raw`\s((?:${AMOUNT}))(?:\s*(CR|DR|Cr|Dr))?(?:\s+((?:${AMOUNT}))(?:\s*(CR|DR|Cr|Dr))?)?\s*$`);
const SKIP_RE = /(PREVIOUS|OPENING|NEW|CLOSING)\s+BALANCE|BALANCE\s+(B\/F|C\/F|BROUGHT|CARRIED)|TOTAL/i;

const toIso = (m) => {
  const d = Number(m[1]);
  const mo = MONTHS[m[2].toUpperCase()] || Number(m[2]);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const num = (s) => Number(s.replace(/,/g, ''));

// A stable id per transaction, so the same line imported twice (upload + Gmail) is skipped.
export const txnHash = (accountId, t) =>
  crypto.createHash('sha256').update([accountId, t.date, t.description.toUpperCase(), t.amount.toFixed(2), t.direction].join('|')).digest('hex').slice(0, 32);

export async function parseStatement(buffer, password) {
  const lines = await pdfLines(buffer, password);
  const out = [];
  let opening = null;
  let closing = null;
  let lastBalance = null;
  // x positions of separate "Debit" / "Credit" amount columns, when the statement has them.
  let cols = null;
  // Description lines wrapped below a transaction are added to it until the next row.
  let wrapping = false;
  for (const { text: line, cells } of lines) {
    const debit = cells.find((c) => /^(debit|withdrawals?)\b/i.test(c.str));
    const credit = cells.find((c) => /^(credit|deposits?)\b/i.test(c.str));
    if (debit && credit) {
      cols = { debit: debit.x, credit: credit.x };
      wrapping = false;
      continue;
    }
    const bal = line.match(new RegExp(String.raw`(PREVIOUS|OPENING|NEW|CLOSING|ACCOUNT|AVAILABLE|LEDGER)\s+BALANCE[^\d-]*(${AMOUNT})\s*(CR|DR)?`, 'i'));
    if (bal) {
      const v = num(bal[2]);
      if (/PREVIOUS|OPENING/i.test(bal[1])) opening = v;
      else closing = v;
      lastBalance = v;
      continue;
    }
    const d = line.match(DATE_RE);
    if (!d) {
      if (wrapping && /[A-Za-z]/.test(line) && !new RegExp(AMOUNT).test(line) && !SKIP_RE.test(line) && line.length <= 60) {
        const t = out.at(-1);
        t.description = `${t.description} ${line}`.slice(0, 200);
      } else wrapping = false;
      continue;
    }
    wrapping = false;
    const date = toIso(d);
    const tail = line.match(TAIL_RE);
    if (!date || !tail) continue;
    let description = line.slice(d[0].length, tail.index).trim();
    // A second date right after the first (transaction date + posting date): drop it.
    const posted = description.match(DATE_RE);
    if (posted) description = description.slice(posted[0].length).trim();
    if (!description || SKIP_RE.test(description)) continue;

    let amount = num(tail[1]);
    let direction = /^cr$/i.test(tail[2] || '') ? 'in' : 'out';
    const cell = cols && cells.find((c) => c.str === tail[1]);
    if (cell) {
      // Debit / Credit columns: the amount's column says which way it went.
      direction = Math.abs(cell.x - cols.credit) < Math.abs(cell.x - cols.debit) ? 'in' : 'out';
      if (tail[3]) lastBalance = num(tail[3]);
    } else if (tail[3]) {
      // "amount balance": the balance going up means money came in.
      const balance = num(tail[3]);
      if (lastBalance != null) direction = balance > lastBalance ? 'in' : 'out';
      lastBalance = balance;
    }
    if (amount < 0) {
      amount = -amount;
      direction = 'in';
    }
    if (!(amount > 0)) continue;
    out.push({ date, description: description.slice(0, 200), amount, direction });
    wrapping = true;
  }
  if (!out.length) throw new StatementError('No transactions found in this PDF. Is it a statement downloaded from online banking (not a scan)?');
  const dates = out.map((t) => t.date).sort();
  return { transactions: out, from: dates[0], to: dates.at(-1), opening, closing };
}

/* ---------- Mapping lines added by hand ---------- */

const MATCH_DAYS = 7;
const dayGap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

// Which line added by hand each statement line replaces (its id, or null). A line's `match` is the user's
// choice: an id, or null for "none". Without a choice it takes the closest open line going the same way
// for the same amount, within a week. Each line added by hand is used once; duplicates never match.
export function matchManual(lines, manual) {
  const open = new Map(manual.map((m) => [m.id, m]));
  const take = (id) => (open.delete(id) ? id : null);
  const out = lines.map((t) => {
    if (t.duplicate || !t.match || open.get(t.match)?.direction !== t.direction) return null;
    return take(t.match);
  });
  lines.forEach((t, i) => {
    if (t.duplicate || t.match !== undefined) return;
    const best = [...open.values()]
      .filter((m) => m.direction === t.direction && Math.abs(m.amount - t.amount) < 0.005 && dayGap(m.date, t.date) <= MATCH_DAYS)
      .sort((a, b) => dayGap(a.date, t.date) - dayGap(b.date, t.date))[0];
    if (best) out[i] = take(best.id);
  });
  return out;
}

/* ---------- Tags ---------- */

// Tags that are not income or expenses (the money only moves between your own accounts).
export const EXCLUDED_TAGS = ['Transfer', 'Card payment', 'Already counted', 'Ignore'];

// Bank wording in front of the merchant: "Debit Card Purchase-KHWAB RESTAURANT" is about KHWAB RESTAURANT.
const PREFIX_RE = /^(DEBIT CARD PURCHASE|CREDIT CARD PURCHASE|CARD PURCHASE|POS PURCHASE|PURCHASE|E-?COM(MERCE)? PURCHASE|APPLE PAY|SAMSUNG PAY)\s*[-:]?\s*/i;

// Merchant of a statement line, for tag rules: "VOX CINEMAS DUBAI ARE" and "VOX CINEMAS - MOE" are both "VOX CINEMAS".
export const merchantKey = (description) =>
  description
    .replace(PREFIX_RE, '')
    .toUpperCase()
    .replace(/[^A-Z& ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !['LLC', 'THE', 'ARE', 'UAE', 'DXB', 'AUH', 'POS', 'PURCHASE'].includes(w))
    .slice(0, 2)
    .join(' ');

// Wording → tag. Each rule names the categories it may go to, best first; the first one in the
// user's own lists is used, so a rule never invents a category. Fixed tags (Transfer…) always apply.
const WORD_RULES = [
  { re: /TRANSFER BETWEEN OWN|OWN ACCOUNTS?\b/i, fixed: 'Transfer' },
  { re: /CASH\s*BACK/i, dir: 'in', fixed: 'Cashback' },
  { re: /PAYMENT RECEIVED|THANK YOU|CARD PAYMENT|CC PAYMENT/i, card: true, dir: 'in', fixed: 'Card payment' },
  { re: /LOAN TRANSACTION|LOAN INSTAL|INSTALL?MENT LOAN|\bEMI\b/i, dir: 'out', fixed: 'Already counted' },
  { re: /SALARY|PAYROLL|\bSAL\b/i, dir: 'in', to: ['Salary'] },
  { re: /\bBONUS\b/i, dir: 'in', to: ['Bonus', 'Salary'] },
  { re: /INTEREST|DIVIDEND|PROFIT PAID/i, dir: 'in', to: ['Interest & dividends', 'Interest', 'Other income'] },
  { re: /CHARGES?\b|\bFEES?\b|COMMISSION|\bVAT\b/i, dir: 'out', to: ['Bank fees', 'Bank charges', 'Fees', 'Other'] },
  { re: /RESTAURANT|CAFE|COFFEE|MESS\b|BAKERY|KITCHEN|GRILL|BIRYANI|PIZZA|BURGER|SHAWARMA|TALABAT|DELIVEROO|ZOMATO|CAREEM FOOD|NOON FOOD|MCDONALD|KFC|STARBUCKS/i, dir: 'out', to: ['Dining', 'Food & dining', 'Food', 'Eating out'] },
  { re: /SUPERMARKET|HYPERMARKET|GROCERY|CARREFOUR|LULU|SPINNEYS|WAITROSE|UNION COOP|CO-?OP|NESTO|GRANDIOSE|VIVA|KIBSONS|INSTASHOP/i, dir: 'out', to: ['Groceries', 'Food'] },
  { re: /DEWA|SEWA|ADDC|FEWA|ETISALAT|\bE&\b|\bDU\b|EMPOWER|ELECTRICITY|WATER|INTERNET|MOBILE RECHARGE/i, dir: 'out', to: ['Utilities', 'Bills'] },
  { re: /SALIK|RTA|NOL\b|PARKING|PETROL|ENOC|ADNOC|EPPCO|EMARAT|CAREEM|UBER|TAXI|METRO/i, dir: 'out', to: ['Transport', 'Fuel', 'Car'] },
  { re: /PHARMACY|CLINIC|HOSPITAL|MEDICAL|ASTER|LIFE PHARMACY|BOOTS|DENTAL/i, dir: 'out', to: ['Health', 'Medical'] },
  { re: /INSURANCE|TAKAFUL/i, dir: 'out', to: ['Insurance'] },
  { re: /\bRENT\b|EJARI|REAL ESTATE|PROPERTIES/i, dir: 'out', to: ['Housing', 'Rent'] },
  { re: /SCHOOL|TUITION|COURSERA|UDEMY|UNIVERSITY|ACADEMY/i, dir: 'out', to: ['Education'] },
  { re: /NETFLIX|SPOTIFY|YOUTUBE|DISNEY|OSN|SHAHID|VOX|REEL CINEMA|NOVO|CINEMA/i, dir: 'out', to: ['Entertainment', 'Subscriptions'] },
  { re: /EMIRATES AIRLINE|FLYDUBAI|AIR ARABIA|ETIHAD|INDIGO|AIR INDIA|BOOKING\.COM|AGODA|EXPEDIA|HOTEL/i, dir: 'out', to: ['Travel'] },
  { re: /AMAZON|NOON|NAMSHI|IKEA|CENTREPOINT|MAX FASHION|SHARAF|EMAX|ACE\b|DECATHLON|MALL/i, dir: 'out', to: ['Shopping'] },
  { re: /EXCHANGE|REMIT|AL ANSARI|LULU MONEY|WESTERN UNION/i, dir: 'out', to: ['Family support'] },
];

// A starting tag for a new line: the merchant's rule (what you tagged before), else the wording rules.
// `categories` are the user's income and expense lists; untagged when nothing fits.
export function autoTag(t, isCard, rules, categories = { income: [], expense: [] }) {
  const rule = rules.get(merchantKey(t.description));
  if (rule) return rule;
  const own = (t.direction === 'in' ? categories.income : categories.expense) || [];
  const find = (name) => own.find((c) => c.toLowerCase() === name.toLowerCase());
  for (const r of WORD_RULES) {
    if (!r.re.test(t.description) || (r.dir && r.dir !== t.direction) || (r.card && !isCard)) continue;
    if (r.fixed) return r.fixed;
    const hit = r.to.map(find).find(Boolean);
    if (hit) return hit;
  }
  return '';
}
