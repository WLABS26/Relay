import { loadConfig } from '@relay/config';
import { loadDotEnv } from '@relay/config/dotenv';
import { ObjectStorage } from '../storage';

/** Idempotently provision the configured bucket (dev/test). Production buckets are IaC-managed. */
loadDotEnv();
const config = loadConfig();
const origins = (process.env.S3_CORS_ORIGINS ?? config.publicOrigin)
  .split(/[\s,]+/)
  .filter(Boolean);
const storage = new ObjectStorage(config.storage);
await storage.ensureBucket(origins);
console.log(
  `[storage] bucket "${config.storage.bucket}" ready (versioning on, CORS for ${origins.join(', ')})`,
);
