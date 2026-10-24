import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { Category, Certification, Phase, Profile } from './models.js';
import * as data from './seedData.js';
import { connect } from './db.js';

// Fills each collection only if it is empty, so it is safe to run on every start.
export async function seedIfEmpty() {
  const seeded = [];
  if ((await Category.countDocuments()) === 0) {
    await Category.insertMany(data.categories);
    seeded.push('categories');
  }
  if ((await Profile.countDocuments()) === 0) {
    await Profile.create(data.profile);
    seeded.push('profile');
  }
  if ((await Phase.countDocuments()) === 0) {
    await Phase.insertMany(data.phases);
    seeded.push('phases');
  }
  if ((await Certification.countDocuments()) === 0) {
    await Certification.insertMany(data.certifications);
    seeded.push('certifications');
  }
  if (seeded.length) console.log(`Seeded: ${seeded.join(', ')}`);
}

// `npm run seed` resets the career plan (profile, phases, certifications) back to the defaults.
// Tasks and categories are never touched.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await connect();
  if (process.argv.includes('--reset-career')) {
    await Promise.all([Profile.deleteMany({}), Phase.deleteMany({}), Certification.deleteMany({})]);
    console.log('Career plan cleared.');
  }
  await seedIfEmpty();
  await mongoose.disconnect();
}
