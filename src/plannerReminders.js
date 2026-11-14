import * as webpush from 'web-push';
import { PlannerSettings, PushDevice, PushSubscription } from './plannerModels.js';
import { fcmConfigured, sendFcm } from './fcm.js';
import { buildToday } from './planner.js';
import { reminderDue, reminderMessage } from './plannerCore.js';

// Daily "plan your day" push reminder. Runs inside the API process every 15 minutes (the host keeps
// Node running). Browsers get Web Push (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT); the iOS/Android
// app gets Firebase Cloud Messaging (FIREBASE_SERVICE_ACCOUNT). Either one turns reminders on.

const EVERY = 15 * 60 * 1000;

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || '';
const webConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
const configured = () => webConfigured() || fcmConfigured();

function setup() {
  if (!webConfigured()) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@devobj.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return true;
}

// Sends to every device of one user: browsers by Web Push, app installs by FCM.
// Subscriptions and tokens the push services reject for good are removed.
export async function sendToUser(owner, message) {
  if (!configured()) throw new Error('Push is not configured on the server (VAPID keys or FIREBASE_SERVICE_ACCOUNT).');
  const [subs, devices] = await Promise.all([
    webConfigured() ? PushSubscription.find({ owner }).lean() : [],
    fcmConfigured() ? PushDevice.find({ owner }).lean() : [],
  ]);
  let sent = 0;
  if (subs.length) setup();
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ ...message, url: '/#/planner' }), { TTL: 3 * 3600 });
      sent += 1;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await PushSubscription.deleteOne({ _id: s._id });
      else console.warn(`Push to ${owner} failed: ${e.statusCode || e.code || e.message || "unknown error"}`);
    }
  }
  if (devices.length) {
    try {
      const r = await sendFcm(devices.map((d) => d.token), { ...message, url: '/#/planner' });
      sent += r.sent;
      if (r.dead.length) await PushDevice.deleteMany({ token: { $in: r.dead } });
    } catch (e) {
      console.warn(`App push to ${owner} failed: ${e.message}`);
    }
  }
  return { devices: subs.length + devices.length, sent };
}

export async function runReminders(now = new Date()) {
  const due = await PlannerSettings.find({ 'reminder.enabled': true }).lean();
  for (const s of due) {
    const when = reminderDue(s.reminder, now);
    if (!when) continue;
    // Claim today first, so a crash or an overlapping run can't send twice.
    const claimed = await PlannerSettings.updateOne(
      { _id: s._id, 'reminder.lastSentOn': { $ne: when.date } },
      { $set: { 'reminder.lastSentOn': when.date } }
    );
    if (!claimed.modifiedCount) continue;
    try {
      const plan = await buildToday(s.owner, when.date, when.minutes, s.reminder.tz);
      await sendToUser(s.owner, reminderMessage(plan));
    } catch (e) {
      console.warn(`Reminder for ${s.owner} failed: ${e.message}`);
    }
  }
}

export function startReminders() {
  if (!configured()) {
    console.log('Planner reminders are off: set VAPID keys (browsers) and/or FIREBASE_SERVICE_ACCOUNT (app) in .env.');
    return;
  }
  if (webConfigured()) setup();
  const tick = () => runReminders().catch((e) => console.warn(`Reminder run failed: ${e.message}`));
  setTimeout(tick, 30 * 1000); // shortly after start
  setInterval(tick, EVERY);
  console.log('Planner reminders: checking every 15 minutes.');
}
