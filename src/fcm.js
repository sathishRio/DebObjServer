import { readFileSync } from 'node:fs';

// Firebase Cloud Messaging for the native Hub app (Android directly, iOS through the APNs key in Firebase).
// FIREBASE_SERVICE_ACCOUNT is the service-account JSON itself, or a path to the file. Off when unset.

let messaging; // resolved lazily, so the server starts without firebase configured

export const fcmConfigured = () => !!process.env.FIREBASE_SERVICE_ACCOUNT;

function credentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
  try {
    return JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8'));
  } catch (e) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is not valid service-account JSON or a readable file (${e.message})`);
  }
}

async function getMessaging() {
  if (!messaging) {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getMessaging: gm } = await import('firebase-admin/messaging');
    const app = getApps().find((a) => a.name === 'hub-push') || initializeApp({ credential: cert(credentials()) }, 'hub-push');
    messaging = gm(app);
  }
  return messaging;
}

// Tokens Firebase says will never work again.
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

// Sends one notification to many tokens. Returns { sent, dead: [tokens to delete] }.
export async function sendFcm(tokens, { title, body, url = '/#/planner' }) {
  if (!tokens.length) return { sent: 0, dead: [] };
  const m = await getMessaging();
  const res = await m.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { url },
    android: { priority: 'high', ttl: 3 * 3600 * 1000, notification: { channelId: 'reminders' } },
    apns: { headers: { 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3 * 3600) }, payload: { aps: { sound: 'default' } } },
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    if (DEAD.has(r.error?.code)) dead.push(tokens[i]);
    else console.warn(`FCM send failed: ${r.error?.code || r.error?.message || 'unknown error'}`);
  });
  return { sent: res.successCount, dead };
}
