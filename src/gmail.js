import { OAuth2Client } from 'google-auth-library';
import { MailSource, WealthRecord } from './models.js';
import { parseStatement } from './statements.js';

/*
 * Gmail statement import (read-only)
 * ----------------------------------
 * The page asks Google for a one-time code (popup, scope gmail.readonly) and posts it here. The
 * refresh token it is exchanged for is stored encrypted with the vault key (WealthRecord kind
 * "gmail"), so Gmail can only be read while the vault is unlocked, and it never goes back to the page.
 *
 * Sync: each "statement email" source (an account + mail subject, optional sender and PDF
 * password) is searched for mails with PDF attachments. New mails' statements are parsed and
 * imported like an upload, so lines already imported are skipped.
 */

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_SEEN = 300;

const oauth = () => new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
const configured = () => !!(process.env.GOOGLE_WEB_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

async function gmailGet(token, path) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Gmail access was revoked. Connect Gmail again.' : `Gmail error ${r.status}`);
  return r.json();
}

// Every PDF attachment in a message (parts can nest).
function pdfParts(part, out = []) {
  if (part.filename && /\.pdf$/i.test(part.filename) && part.body?.attachmentId) out.push(part);
  for (const p of part.parts || []) pdfParts(p, out);
  return out;
}

const gmailDate = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
const quote = (s) => `"${s.replace(/"/g, '')}"`;

export function gmailRoutes(router, { ah, HttpError, store, reveal, reseal, strip, validated, importStatement, statementError }) {
  const tokenRecord = (vault) => WealthRecord.findOne({ owner: vault.owner, kind: 'gmail' });

  router.get(
    '/gmail/status',
    ah(async (req, res) => {
      const rec = await tokenRecord(req.vault);
      res.json({ configured: configured(), clientId: process.env.GOOGLE_WEB_CLIENT_ID || '', connected: !!rec, email: rec ? reveal(req.vault, rec).email : '' });
    })
  );

  router.post(
    '/gmail/connect',
    ah(async (req, res) => {
      if (!configured()) throw new HttpError(400, 'Gmail is not set up on the server (GOOGLE_CLIENT_SECRET in server/.env).');
      const code = req.body?.code;
      if (typeof code !== 'string' || !code) throw new HttpError(400, 'Missing Google code');
      let tokens;
      try {
        ({ tokens } = await oauth().getToken(code));
      } catch {
        throw new HttpError(400, 'Google did not accept the sign-in. Try connecting again.');
      }
      if (!tokens.refresh_token) throw new HttpError(400, 'Google did not return offline access. Remove the app at myaccount.google.com/permissions and connect again.');
      if (!String(tokens.scope || '').includes(GMAIL_SCOPE)) throw new HttpError(400, 'Gmail read access was not granted.');
      const profile = await gmailGet(tokens.access_token, '/profile');
      const plain = { refreshToken: tokens.refresh_token, email: profile.emailAddress };
      const rec = await tokenRecord(req.vault);
      if (rec) await reseal(req.vault, rec, plain);
      else await store(req.vault, 'gmail', plain);
      res.json({ connected: true, email: plain.email });
    })
  );

  router.delete(
    '/gmail',
    ah(async (req, res) => {
      const rec = await tokenRecord(req.vault);
      if (rec) {
        const { refreshToken } = reveal(req.vault, rec);
        await oauth().revokeToken(refreshToken).catch(() => {}); // best effort
        await rec.deleteOne();
      }
      res.status(204).end();
    })
  );

  // Syncs every statement email source, or just `sourceId`. Returns a line per source.
  router.post(
    '/gmail/sync',
    ah(async (req, res) => {
      const vault = req.vault;
      const rec = await tokenRecord(vault);
      if (!rec) throw new HttpError(400, 'Connect Gmail first');
      const client = oauth();
      client.setCredentials({ refresh_token: reveal(vault, rec).refreshToken });
      let token;
      try {
        ({ token } = await client.getAccessToken());
      } catch {
        throw new HttpError(400, 'Gmail access expired or was revoked. Connect Gmail again.');
      }

      const filter = { owner: vault.owner, kind: 'sources', ...(req.body?.sourceId ? { _id: req.body.sourceId } : {}) };
      const results = [];
      const created = [];
      const accounts = [];
      for (const srcRec of await WealthRecord.find(filter)) {
        const src = strip(reveal(vault, srcRec));
        const result = { sourceId: String(srcRec._id), account: src.account, subject: src.subject, mails: 0, imported: 0, duplicates: 0, errors: [] };
        try {
          const since = src.lastSync ? new Date(new Date(src.lastSync).getTime() - 3 * 86_400_000) : new Date(Date.now() - 365 * 86_400_000);
          const q = [`subject:${quote(src.subject)}`, src.sender && `from:${quote(src.sender)}`, 'has:attachment', 'filename:pdf', `after:${gmailDate(since)}`]
            .filter(Boolean)
            .join(' ');
          const list = await gmailGet(token, `/messages?maxResults=50&q=${encodeURIComponent(q)}`);
          const seen = new Set(src.seen || []);
          // Oldest first, so the newest statement sets the account balance last.
          for (const { id } of (list.messages || []).reverse()) {
            if (seen.has(id)) continue;
            const msg = await gmailGet(token, `/messages/${id}`);
            let ok = true;
            for (const part of pdfParts(msg.payload || {})) {
              result.mails += 1;
              const att = await gmailGet(token, `/messages/${id}/attachments/${part.body.attachmentId}`);
              try {
                const parsed = await parseStatement(Buffer.from(att.data, 'base64url'), src.password).catch(statementError);
                const r = await importStatement(vault, src.account, parsed, 'gmail');
                result.imported += r.created.length + r.matched.length;
                result.duplicates += r.duplicates;
                created.push(...r.created, ...r.matched); // the page replaces mapped lines by id
                if (r.account) accounts.push(r.account);
              } catch (e) {
                ok = false;
                result.errors.push(`${part.filename}: ${e.message}`);
              }
            }
            if (ok) seen.add(id); // a failed mail (e.g. wrong password) is retried next sync
          }
          src.seen = [...seen].slice(-MAX_SEEN);
          src.lastSync = new Date();
        } catch (e) {
          result.errors.push(e.message);
        }
        src.lastResult = result.errors.length ? result.errors[0].slice(0, 300) : `${result.imported} new, ${result.duplicates} already imported`;
        results.push({ ...result, source: await reseal(vault, srcRec, await validated(MailSource, src, vault.owner)) });
      }
      res.json({ results, created, accounts });
    })
  );
}
