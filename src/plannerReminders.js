import * as webpush from 'web-push';
import { PlannerSettings, PushSubscription } from './plannerModels.js';
import { buildToday } from './planner.js';
import { reminderDue, reminderMessage } from './plannerCore.js';

// Daily "plan your day" push reminder. Runs inside the API process every 15 minutes (the host keeps
// Node running). Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in .env; off otherwise.

const EVERY = 15 * 60 * 1000;

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || '';
const configured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

function setup() {
  if (!configured()) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@devobj.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return true;
}

// Sends to every device of one user. Expired subscriptions (404/410) are removed.
export async function sendToUser(owner, message) {
  if (!setup()) throw new Error('Push is not configured on the server (VAPID keys).');
  const subs = await PushSubscription.find({ owner }).lean();
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ ...message, url: '/#/planner' }), { TTL: 3 * 3600 });
      sent += 1;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await PushSubscription.deleteOne({ _id: s._id });
      else console.warn(`Push to ${owner} failed: ${e.statusCode || e.code || e.message || "unknown error"}`);
    }
  }
  return { devices: subs.length, sent };
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
    console.log('Planner reminders are off: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env to turn them on.');
    return;
  }
  setup();
  const tick = () => runReminders().catch((e) => console.warn(`Reminder run failed: ${e.message}`));
  setTimeout(tick, 30 * 1000); // shortly after start
  setInterval(tick, EVERY);
  console.log('Planner reminders: checking every 15 minutes.');
}
