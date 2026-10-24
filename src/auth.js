import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';

// Sign-in flow: the app gets a Google ID token (Google Identity Services on web, native
// Google Sign-In on mobile) and posts it here. We verify it with Google, check the email
// against ALLOWED_EMAILS, and issue our own session token used on every /api request.

const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

// Read lazily so values come from .env (loaded in index.js) and edits apply on restart.
const settings = () => ({
  webClientId: process.env.GOOGLE_WEB_CLIENT_ID || '',
  // Mobile ID tokens are issued for the web client ID (webClientId in the app), but extra
  // client IDs (e.g. iOS) can be accepted too.
  audiences: [process.env.GOOGLE_WEB_CLIENT_ID, ...list(process.env.GOOGLE_EXTRA_CLIENT_IDS)].filter(Boolean),
  allowed: list(process.env.ALLOWED_EMAILS).map((e) => e.toLowerCase()),
  secret: process.env.JWT_SECRET || '',
  days: Number(process.env.SESSION_DAYS) || 30,
  // Dev mode: an "Admin" button signs in as the first ALLOWED_EMAILS account without Google.
  devLogin: process.env.DEV_LOGIN === 'true',
});

// Refuse to start half-configured: an empty allowlist or secret would lock you out or be unsafe.
export function assertAuthConfig() {
  const s = settings();
  const problems = [];
  if (!s.webClientId && !s.devLogin) problems.push('GOOGLE_WEB_CLIENT_ID is not set (or set DEV_LOGIN=true while developing)');
  if (!s.allowed.length) problems.push('ALLOWED_EMAILS is not set');
  if (s.secret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  if (s.devLogin && process.env.NODE_ENV === 'production') problems.push('DEV_LOGIN must not be enabled when NODE_ENV=production');
  if (problems.length) {
    throw new Error(`Auth is not configured (server/.env):\n  - ${problems.join('\n  - ')}`);
  }
  if (s.devLogin) {
    console.warn(`DEV MODE: "Admin" login is enabled for ${s.allowed[0]} from this PC and your local network. Set DEV_LOGIN=false before going online.`);
  }
}

// Loopback and private-network addresses (this PC, or a phone on the same Wi-Fi).
const LOCAL_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:|fc|fd)/i;
// Behind a reverse proxy every request looks local, so any forwarded request counts as remote.
const isLocalRequest = (req) =>
  !req.get('x-forwarded-for') && !req.get('forwarded') && !req.get('x-real-ip') &&
  LOCAL_IP.test((req.socket.remoteAddress || '').replace(/^::ffff:/, ''));

const isAllowed = (email) => settings().allowed.includes((email || '').toLowerCase());

const googleClient = new OAuth2Client();

// Express middleware: requires "Authorization: Bearer <session token>" from an allowed user.
export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Sign in required' });
  try {
    const user = jwt.verify(token, settings().secret, { algorithms: ['HS256'] });
    // Re-checked on every request, so removing an email from ALLOWED_EMAILS locks it out immediately.
    if (!isAllowed(user.email)) return res.status(403).json({ error: 'This Google account is no longer allowed' });
    // Admin (dev) sessions stop working the moment dev mode is switched off.
    if (user.dev && !settings().devLogin) return res.status(401).json({ error: 'Dev mode is off. Please sign in with Google.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

const router = Router();

// Public: the apps read the Google client ID and whether the dev "Admin" button is available.
router.get('/config', (req, res) => {
  const s = settings();
  res.json({ googleClientId: s.webClientId, devLogin: s.devLogin && isLocalRequest(req) });
});

const issueSession = (user, extra = {}) => {
  const s = settings();
  return jwt.sign({ ...user, ...extra }, s.secret, { algorithm: 'HS256', expiresIn: `${s.days}d`, subject: user.email });
};

// Dev mode only, local network only: signs in as the first allowed account without Google.
router.post('/dev', (req, res) => {
  const s = settings();
  if (!s.devLogin || !isLocalRequest(req)) return res.status(404).json({ error: 'Not found' });
  const user = { email: s.allowed[0], name: 'Admin (dev mode)', picture: '' };
  console.warn(`DEV MODE: Admin login from ${req.socket.remoteAddress}`);
  res.json({ token: issueSession(user, { dev: true }), user });
});

router.post('/google', async (req, res) => {
  const { idToken } = req.body || {};
  if (typeof idToken !== 'string' || !idToken) return res.status(400).json({ error: 'idToken is required' });

  const s = settings();
  if (!s.webClientId) return res.status(503).json({ error: 'Google sign-in is not configured on the server yet' });
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: s.audiences });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'Google sign-in could not be verified' });
  }

  if (!payload?.email || !payload.email_verified || !isAllowed(payload.email)) {
    console.warn(`Rejected sign-in from ${payload?.email || 'unknown account'}`);
    return res.status(403).json({ error: `${payload?.email || 'This account'} is not allowed to use this app` });
  }

  const user = { email: payload.email.toLowerCase(), name: payload.name || '', picture: payload.picture || '' };
  res.json({ token: issueSession(user), user });
});

router.get('/me', requireAuth, (req, res) => {
  const { email, name, picture, exp, dev } = req.user;
  res.json({ email, name, picture, dev: !!dev, expiresAt: new Date(exp * 1000).toISOString() });
});

export default router;
