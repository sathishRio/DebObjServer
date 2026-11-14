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

const SOUNDS = { reminder: 'reminder', due_soon: 'reminder', digest: 'reminder', plan: 'free', overdue: 'overdue' };
const strings = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));

// One FCM message for a device. A message with `alert` (task / plan alert with Done, Skip, Remind me…):
// Android gets data only and the app draws it (colors, timer, buttons: HubMessagingService);
// iOS gets the HUB_ALERT category (buttons) and the kind's sound (AppDelegate). Others: a plain notification.
function messageFor(device, { title, body, url = '/#/planner', alert }) {
  const expires = String(Math.floor(Date.now() / 1000) + 3 * 3600);
  if (!alert) {
    return {
      token: device.token,
      notification: { title, body },
      data: { url },
      android: { priority: 'high', ttl: 3 * 3600 * 1000, notification: { channelId: 'reminders' } },
      apns: { headers: { 'apns-expiration': expires }, payload: { aps: { sound: 'default' } } },
    };
  }
  const data = strings({ hubAlert: '1', title, body, url, ...alert, sound: SOUNDS[alert.kind] || 'reminder' });
  if (device.platform === 'android') return { token: device.token, data, android: { priority: 'high', ttl: 3 * 3600 * 1000 } };
  return {
    token: device.token,
    notification: { title, body },
    data,
    apns: {
      headers: { 'apns-expiration': expires, 'apns-collapse-id': alert.id },
      payload: { aps: { sound: `hub_${data.sound}.wav`, category: 'HUB_ALERT', 'thread-id': alert.id } },
    },
  };
}

// Sends one notification to many devices ({ token, platform }). Returns { sent, dead: [tokens to delete] }.
export async function sendFcm(devices, message) {
  if (!devices.length) return { sent: 0, dead: [] };
  const m = await getMessaging();
  const res = await m.sendEach(devices.map((d) => messageFor(d, message)));
  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    if (DEAD.has(r.error?.code)) dead.push(devices[i].token);
    else console.warn(`FCM send failed: ${r.error?.code || r.error?.message || 'unknown error'}`);
  });
  return { sent: res.successCount, dead };
}
