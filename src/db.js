import 'dotenv/config';
import mongoose from 'mongoose';

export async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Copy server/.env.example to server/.env and fill it in.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
}
