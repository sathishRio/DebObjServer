import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { VaultEntry, VaultMeta } from './models.js';

/*
 * Password vault crypto
 * ---------------------
 * - Each account's vault has a random 256-bit data key (DEK). Entries are encrypted with it
 *   using AES-256-GCM (random IV per value, authenticated).
 * - The DEK is stored only "wrapped" (AES-256-GCM) by a key-encryption key:
 *     KEK = scrypt(HMAC-SHA256(VAULT_SECRET, PIN), salt)
 *   so it needs BOTH the 4-digit PIN and VAULT_SECRET (server/.env, never in the database).
 *   A copied database alone can't be brute-forced: 10,000 PINs are useless without the secret.
 * - A wrong PIN fails GCM authentication when unwrapping, so no separate PIN hash is stored.
 * - Wrong PINs are counted in the database; MAX_ATTEMPTS failures lock the vault for LOCK_MINUTES.
 * - Unlocking keeps the DEK in server memory for UNLOCK_MINUTES, behind a random unlock token.
 */

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTS = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }; // ~64 MB, ~0.2 s
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const UNLOCK_MINUTES = 5;
const PIN_RE = /^\d{4}$/;

export function assertVaultConfig() {
  if ((process.env.VAULT_SECRET || '').length < 32) {
    throw new Error('Vault is not configured (server/.env):\n  - VAULT_SECRET must be at least 32 characters');
  }
}

/* ---------- Primitives ---------- */

const b64 = (buf) => buf.toString('base64');

// Serialized as "v1:<iv>:<tag>:<ciphertext>" (base64 parts).
function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(data)}`;
}

// Throws if the key is wrong or the data was tampered with.
function open(key, sealed, aad) {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== 'v1') throw new Error('Unknown vault format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
}

async function deriveKek(pin, saltB64) {
  const peppered = crypto.createHmac('sha256', process.env.VAULT_SECRET).update(pin).digest();
  return scrypt(peppered, Buffer.from(saltB64, 'base64'), 32, SCRYPT_OPTS);
}

// AAD binds ciphertexts to their owner, so values can't be swapped between vaults.
const keyAad = (owner) => `vault-key:${owner}`;
const entryAad = (owner) => `vault-entry:${owner}`;

async function wrapKey(dek, pin, owner) {
  const kdfSalt = b64(crypto.randomBytes(16));
  return { kdfSalt, wrappedKey: seal(await deriveKek(pin, kdfSalt), dek, keyAad(owner)) };
}

/* ---------- Unlock sessions (memory only: a restart locks every vault) ---------- */

const sessions = new Map(); // token -> { owner, dek, expiresAt }

function sweep() {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token);
}

function startSession(owner, dek) {
  sweep();
  for (const [token, s] of sessions) if (s.owner === owner) sessions.delete(token); // one per account
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + UNLOCK_MINUTES * 60_000;
  sessions.set(token, { owner, dek, expiresAt });
  return { unlockToken: token, expiresAt: new Date(expiresAt).toISOString() };
}

function sessionFor(req) {
  sweep();
  const s = sessions.get(req.get('x-vault-unlock') || '');
  return s && s.owner === req.user.email ? s : null;
}

/* ---------- PIN check with lockout ---------- */

class VaultError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    Object.assign(this, { status, extra });
  }
}

// Returns the DEK, or throws a VaultError (wrong PIN, locked out, not set up).
async function unwrapWithPin(owner, pin) {
  if (!PIN_RE.test(pin || '')) throw new VaultError(400, 'PIN must be exactly 4 digits');
  const meta = await VaultMeta.findOne({ owner });
  if (!meta) throw new VaultError(409, 'Vault is not set up yet');
  if (meta.lockedUntil && meta.lockedUntil > new Date()) {
    throw new VaultError(429, 'Too many wrong PINs. Vault is locked.', { lockedUntil: meta.lockedUntil });
  }
  try {
    const dek = open(await deriveKek(pin, meta.kdfSalt), meta.wrappedKey, keyAad(owner));
    if (meta.failedAttempts || meta.lockedUntil) {
      meta.failedAttempts = 0;
      meta.lockedUntil = null;
      await meta.save();
    }
    return { dek, meta };
  } catch {
    // Atomic increment, so parallel guesses can't slip past the limit.
    const updated = await VaultMeta.findOneAndUpdate({ owner }, { $inc: { failedAttempts: 1 } }, { new: true });
    if (updated.failedAttempts >= MAX_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      await VaultMeta.updateOne({ owner }, { failedAttempts: 0, lockedUntil });
      console.warn(`Vault locked for ${owner} after ${MAX_ATTEMPTS} wrong PINs`);
      throw new VaultError(429, `Too many wrong PINs. Vault is locked for ${LOCK_MINUTES} minutes.`, { lockedUntil });
    }
    throw new VaultError(400, 'Wrong PIN', { attemptsLeft: MAX_ATTEMPTS - updated.failedAttempts });
  }
}

/* ---------- Routes (mounted behind requireAuth; req.user.email is the owner) ---------- */

const router = Router();
const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) =>
    e instanceof VaultError ? res.status(e.status).json({ error: e.message, ...e.extra }) : next(e)
  );

// Secrets must never be cached by the browser or a proxy.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// 423 Locked: distinct from 401 so the app doesn't treat it as "signed out".
const requireUnlocked = (req, res, next) => {
  const s = sessionFor(req);
  if (!s) return res.status(423).json({ error: 'Vault is locked. Enter your PIN.' });
  req.vault = s;
  next();
};

router.get(
  '/status',
  ah(async (req, res) => {
    const meta = await VaultMeta.findOne({ owner: req.user.email });
    const s = sessionFor(req);
    res.json({
      initialized: !!meta,
      unlocked: !!s,
      unlockExpiresAt: s ? new Date(s.expiresAt).toISOString() : null,
      lockedUntil: meta?.lockedUntil > new Date() ? meta.lockedUntil : null,
    });
  })
);

router.post(
  '/setup',
  ah(async (req, res) => {
    const owner = req.user.email;
    const { pin } = req.body || {};
    if (!PIN_RE.test(pin || '')) throw new VaultError(400, 'PIN must be exactly 4 digits');
    if (await VaultMeta.exists({ owner })) throw new VaultError(409, 'Vault is already set up');
    const dek = crypto.randomBytes(32);
    await VaultMeta.create({ owner, ...(await wrapKey(dek, pin, owner)) });
    res.status(201).json(startSession(owner, dek));
  })
);

router.post(
  '/unlock',
  ah(async (req, res) => {
    const { dek } = await unwrapWithPin(req.user.email, req.body?.pin);
    res.json(startSession(req.user.email, dek));
  })
);

router.post('/lock', (req, res) => {
  sessions.delete(req.get('x-vault-unlock') || '');
  res.status(204).end();
});

// Re-wraps the same data key, so entries don't need re-encrypting.
router.post(
  '/pin',
  ah(async (req, res) => {
    const owner = req.user.email;
    const { currentPin, newPin } = req.body || {};
    if (!PIN_RE.test(newPin || '')) throw new VaultError(400, 'New PIN must be exactly 4 digits');
    const { dek, meta } = await unwrapWithPin(owner, currentPin);
    Object.assign(meta, await wrapKey(dek, newPin, owner));
    await meta.save();
    res.json(startSession(owner, dek));
  })
);

// Forgotten PIN: the only way out is deleting the vault. Requires typing DELETE.
router.delete(
  '/',
  ah(async (req, res) => {
    if (req.body?.confirm !== 'DELETE') throw new VaultError(400, 'Type DELETE to confirm');
    const owner = req.user.email;
    await Promise.all([VaultEntry.deleteMany({ owner }), VaultMeta.deleteOne({ owner })]);
    for (const [token, s] of sessions) if (s.owner === owner) sessions.delete(token);
    res.status(204).end();
  })
);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Listing needs no PIN: it returns no secrets. ?page=1&limit=10&q=search
router.get(
  '/entries',
  ah(async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const filter = { owner: req.user.email };
    const q = String(req.query.q || '').trim();
    if (q) {
      const re = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ title: re }, { username: re }, { url: re }];
    }
    const total = await VaultEntry.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
    const items = await VaultEntry.find(filter)
      .collation({ locale: 'en', strength: 2 })
      .sort({ title: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit);
    res.json({ items, page, pages, total, limit });
  })
);

const ENTRY_TEXT = ['title', 'username', 'url'];
const pickText = (body) => Object.fromEntries(ENTRY_TEXT.filter((k) => typeof body[k] === 'string').map((k) => [k, body[k]]));

router.post(
  '/entries',
  requireUnlocked,
  ah(async (req, res) => {
    const { password, notes } = req.body || {};
    if (typeof password !== 'string' || !password) throw new VaultError(400, 'Password is required');
    const { owner, dek } = req.vault;
    const entry = await VaultEntry.create({
      ...pickText(req.body),
      owner,
      password: seal(dek, password, entryAad(owner)),
      notes: notes ? seal(dek, String(notes), entryAad(owner)) : '',
    });
    res.status(201).json(entry);
  })
);

router.put(
  '/entries/:id',
  requireUnlocked,
  ah(async (req, res) => {
    const { owner, dek } = req.vault;
    const entry = await VaultEntry.findOne({ _id: req.params.id, owner });
    if (!entry) throw new VaultError(404, 'Entry not found');
    entry.set(pickText(req.body));
    const { password, notes } = req.body || {};
    if (typeof password === 'string' && password) entry.password = seal(dek, password, entryAad(owner));
    if (typeof notes === 'string') entry.notes = notes ? seal(dek, notes, entryAad(owner)) : '';
    res.json(await entry.save());
  })
);

router.delete(
  '/entries/:id',
  requireUnlocked,
  ah(async (req, res) => {
    const entry = await VaultEntry.findOneAndDelete({ _id: req.params.id, owner: req.vault.owner });
    if (!entry) throw new VaultError(404, 'Entry not found');
    res.status(204).end();
  })
);

// POST (not GET) so decrypted secrets never land in URLs, history or logs.
router.post(
  '/entries/:id/reveal',
  requireUnlocked,
  ah(async (req, res) => {
    const { owner, dek } = req.vault;
    const entry = await VaultEntry.findOne({ _id: req.params.id, owner });
    if (!entry) throw new VaultError(404, 'Entry not found');
    res.json({
      password: open(dek, entry.password, entryAad(owner)).toString('utf8'),
      notes: entry.notes ? open(dek, entry.notes, entryAad(owner)).toString('utf8') : '',
    });
  })
);

export default router;
