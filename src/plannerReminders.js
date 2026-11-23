import { PlannerSettings, PushDevice } from './plannerModels.js';
import { fcmConfigured, sendFcm } from './fcm.js';
import { buildToday } from './planner.js';
import { reminderDue, reminderMessage } from './plannerCore.js';

// Daily "plan your day" push reminder. Runs inside the API process every 15 minutes (the host keeps
// Node running). Notifications go to the iOS/Android app only, by Firebase Cloud Messaging
// (FIREBASE_SERVICE_ACCOUNT); browsers don't get push.

const EVERY = 15 * 60 * 1000;

const configured = fcmConfigured;
export const pushConfigured = configured;

// What is set up, for the push test screen.
export const pushStatus = () => ({ app: fcmConfigured() });

// Sends to every app install of one user (or just `only`: one PushDevice id) by FCM. Tokens Firebase
// rejects for good are removed. Returns totals, the reasons sends failed, and one result per device ({ id, ok, error }).
export async function sendToUser(owner, message, { only } = {}) {
  if (!configured()) throw new Error('Push is not configured on the server (FIREBASE_SERVICE_ACCOUNT).');
  const devices = await PushDevice.find(only ? { owner, _id: only } : { owner }).lean();
  let sent = 0;
  const errors = []; // why sends failed, for the test button (the daily job only logs them)
  const results = [];
  if (devices.length) {
    try {
      const r = await sendFcm(devices, { url: '/#/planner', ...message });
      sent += r.sent;
      errors.push(...r.errors);
      r.results.forEach((x, i) => results.push({ id: String(devices[i]._id), ...x }));
      if (r.dead.length) await PushDevice.deleteMany({ token: { $in: r.dead } });
    } catch (e) {
      errors.push(e.message);
      devices.forEach((d) => results.push({ id: String(d._id), ok: false, error: e.message }));
      console.warn(`App push to ${owner} failed: ${e.message}`);
    }
  }
  return { devices: devices.length, sent, errors, results };
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
    console.log('Planner reminders are off: set FIREBASE_SERVICE_ACCOUNT in .env.');
    return;
  }
  const tick = () => runReminders().catch((e) => console.warn(`Reminder run failed: ${e.message}`));
  setTimeout(tick, 30 * 1000); // shortly after start
  setInterval(tick, EVERY);
  console.log('Planner reminders: checking every 15 minutes.');
}
