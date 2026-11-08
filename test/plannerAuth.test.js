import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'x'.repeat(40);
process.env.ALLOWED_EMAILS = 'owner@example.com';
process.env.LEARN_ALLOWED_EMAILS = 'learner@example.com';
const { requireAuth } = await import('../src/auth.js');

// The planner is mounted behind requireAuth; Learn-only sessions must be refused.
function run(token) {
  const req = { get: (h) => (h.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined) };
  const out = { status: 200, next: false };
  const res = { status(c) { out.status = c; return this; }, json() { return this; } };
  requireAuth(req, res, () => { out.next = true; out.email = req.user.email; });
  return out;
}
const sign = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256' });

test('full account passes', () => {
  assert.deepEqual(run(sign({ email: 'owner@example.com' })), { status: 200, next: true, email: 'owner@example.com' });
});

test('Learn-only session gets 403', () => {
  const r = run(sign({ email: 'learner@example.com', scope: 'learn' }));
  assert.equal(r.status, 403);
  assert.equal(r.next, false);
});

test('Learn-scoped token for a full account is still refused', () => {
  assert.equal(run(sign({ email: 'owner@example.com', scope: 'learn' })).status, 403);
});
