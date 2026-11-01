/*
 * One-off: copy Wealth data from the local database to production, when production's database
 * is only reachable from the production server.
 *
 * Wealth records are encrypted with each environment's vault data key (DEK), wrapped by that
 * environment's PIN + VAULT_SECRET. Records are decrypted and re-encrypted only on the local
 * machine; the file carried to the server holds production-encrypted data only.
 * Nothing else (tasks, notes, vault passwords, VaultMeta) is touched.
 *
 * Three steps. Each uses MONGODB_URI / VAULT_SECRET of the machine it runs on.
 * OWNER defaults to the first ALLOWED_EMAILS.
 *
 *   1. ON THE SERVER   node scripts/migrate-wealth-to-prod.js export-meta
 *        writes wealth-prod-meta.json (prod vault salt + wrapped key; useless without PIN + secret)
 *
 *   2. LOCALLY         node scripts/migrate-wealth-to-prod.js prepare wealth-prod-meta.json
 *        needs PROD_VAULT_SECRET; asks local PIN and prod PIN; writes wealth-migration.json
 *
 *   3. ON THE SERVER   node scripts/migrate-wealth-to-prod.js import wealth-migration.json
 *        dry run: asks prod PIN, checks every record decrypts, writes nothing
 *        add --apply to write; add --replace to first delete the account's existing Wealth data
 *
 * Delete both JSON files afterwards.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import readline from 'node:readline';
import mongoose from 'mongoose';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTS = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }; // must match src/vault.js
const SCOPE = 'wealth'; // must match src/wealth.js

const [command, fileArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
const replace = process.argv.includes('--replace');
const owner = process.env.OWNER || (process.env.ALLOWED_EMAILS || '').split(',')[0].trim();
const aad = `${SCOPE}:${owner}`;

/* ---------- Crypto (same format as src/vault.js) ---------- */

function seal(key, plaintext, aadStr) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aadStr));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

function open(key, sealed, aadStr) {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== 'v1') throw new Error('Unknown vault format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aadStr));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
}

async function unwrapDek(meta, secret, pin, label) {
  const peppered = crypto.createHmac('sha256', secret).update(pin).digest();
  const kek = await scrypt(peppered, Buffer.from(meta.kdfSalt, 'base64'), 32, SCRYPT_OPTS);
  try {
    return open(kek, meta.wrappedKey, `vault-key:${owner}`);
  } catch {
    throw new Error(`${label}: wrong PIN or VAULT_SECRET.`);
  }
}

/* ---------- Helpers ---------- */

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : '');
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function requireEnv(...keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing: ${missing.join(', ')}`);
  if (!owner) throw new Error('Set OWNER (your Google email)');
}

async function connect() {
  const conn = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
  console.log(`Database: ${conn.host}/${conn.name}\nAccount:  ${owner}\n`);
  return conn;
}

async function vaultMeta(db, label) {
  const meta = await db.collection('vaultmetas').findOne({ owner });
  if (!meta) throw new Error(`${label}: the vault is not set up for ${owner}. Set it up in the app first.`);
  return meta;
}

function readJson(path, what) {
  if (!path) throw new Error(`Give the ${what} file path`);
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

/* ---------- Steps ---------- */

async function exportMeta() {
  requireEnv('MONGODB_URI');
  const conn = await connect();
  try {
    const meta = await vaultMeta(conn.db, 'Production');
    const out = fileArg || 'wealth-prod-meta.json';
    fs.writeFileSync(out, JSON.stringify({ owner, kdfSalt: meta.kdfSalt, wrappedKey: meta.wrappedKey }, null, 2));
    console.log(`Wrote ${out}. Copy it to your local server/ folder and run "prepare".`);
  } finally {
    await conn.close();
  }
}

async function prepare() {
  requireEnv('MONGODB_URI', 'VAULT_SECRET', 'PROD_VAULT_SECRET');
  const prodMeta = readJson(fileArg, 'wealth-prod-meta.json');
  if (prodMeta.owner !== owner) throw new Error(`Meta file is for ${prodMeta.owner}, not ${owner}`);
  const conn = await connect();
  try {
    const localDek = await unwrapDek(await vaultMeta(conn.db, 'Local'), process.env.VAULT_SECRET, await askHidden('Local vault PIN: '), 'Local');
    const prodDek = await unwrapDek(prodMeta, process.env.PROD_VAULT_SECRET, await askHidden('Production vault PIN: '), 'Production');

    const records = await conn.db.collection('wealthrecords').find({ owner }).toArray();
    const docs = records.map((r) => ({
      kind: r.kind,
      key: r.key || '',
      data: seal(prodDek, open(localDek, r.data, aad), aad), // throws if any record fails: no file written
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    const byKind = docs.reduce((m, d) => ({ ...m, [d.kind]: (m[d.kind] || 0) + 1 }), {});
    fs.writeFileSync('wealth-migration.json', JSON.stringify({ owner, count: docs.length, docs }, null, 2));
    console.log(`Re-encrypted ${docs.length} records`, byKind);
    console.log('Wrote wealth-migration.json (production-encrypted). Copy it to the server and run "import".');
  } finally {
    await conn.close();
  }
}

async function importRecords() {
  requireEnv('MONGODB_URI', 'VAULT_SECRET');
  const file = readJson(fileArg, 'wealth-migration.json');
  if (file.owner !== owner) throw new Error(`File is for ${file.owner}, not ${owner}`);
  if (file.docs.length !== file.count) throw new Error('File is incomplete');
  console.log(`Mode: ${apply ? `APPLY${replace ? ' + REPLACE' : ''}` : 'dry run (nothing is written)'}`);
  const conn = await connect();
  try {
    const dek = await unwrapDek(await vaultMeta(conn.db, 'Production'), process.env.VAULT_SECRET, await askHidden('Production vault PIN: '), 'Production');
    for (const d of file.docs) open(dek, d.data, aad); // every record must open with this server's key
    console.log(`File records: ${file.count}, all readable with this server's key`);

    const col = conn.db.collection('wealthrecords');
    const existing = await col.countDocuments({ owner });
    console.log(`Already in database: ${existing}`);
    if (existing && !replace) {
      throw new Error('This database already has Wealth data for this account. Back it up, then re-run with --replace.');
    }
    if (!apply) return console.log('\nDry run OK. Re-run with --apply to write.');

    if (existing) console.log(`Deleted ${(await col.deleteMany({ owner })).deletedCount} records`);
    const docs = file.docs.map((d) => ({ owner, ...d, createdAt: new Date(d.createdAt), updatedAt: new Date(d.updatedAt), __v: 0 }));
    if (docs.length) await col.insertMany(docs);
    const written = await col.find({ owner }).toArray();
    for (const r of written) open(dek, r.data, aad);
    console.log(`\nDone: ${written.length} records, all readable with the production PIN. Delete the JSON files now.`);
  } finally {
    await conn.close();
  }
}

const steps = { 'export-meta': exportMeta, prepare, import: importRecords };
(steps[command] || (() => Promise.reject(new Error('Usage: export-meta | prepare <meta.json> | import <migration.json> [--apply] [--replace]'))))()
  .catch((e) => {
    console.error(`\n${e.message}`);
    process.exit(1);
  });
