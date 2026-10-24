import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import { connect } from './db.js';
import routes from './routes.js';
import authRoutes, { assertAuthConfig, requireAuth } from './auth.js';
import vaultRoutes, { assertVaultConfig } from './vault.js';
import { seedIfEmpty } from './seed.js';

const app = express();
// Behind the hosting panel's proxy (Passenger/Nginx): take the client IP from X-Forwarded-For.
app.set('trust proxy', 1);
// The web app (task.devobj.com) is a separate origin; CORS_ORIGINS lists who may call the API.
// Empty = allow any origin (local development). Requests carry a Bearer token, not cookies.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : {}));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' })
);

// Google sign-in (public), then everything else under /api requires an allowed, signed-in user.
app.use('/api/auth', authRoutes);
app.use('/api/vault', requireAuth, vaultRoutes);
app.use('/api', requireAuth, routes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Turn Mongoose errors into readable 4xx responses instead of 500s.
app.use((err, _req, res, _next) => {
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map((e) => e.message).join('; ');
    return res.status(400).json({ error: message });
  }
  if (err.name === 'CastError') return res.status(400).json({ error: `Invalid ${err.path}` });
  if (err.code === 11000) return res.status(409).json({ error: 'That name already exists' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const port = Number(process.env.PORT) || 4000;

assertAuthConfig();
assertVaultConfig();
await connect();
await seedIfEmpty();
// Listen on all interfaces so a phone on the same network can reach the API.
app.listen(port, '0.0.0.0', () => console.log(`API listening on http://0.0.0.0:${port}/api`));
