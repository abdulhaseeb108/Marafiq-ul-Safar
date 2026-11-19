import { createHash } from 'node:crypto';
import { Schema, model } from 'mongoose';

/**
 * Failed sign-in and 2FA attempts, counted per key (IP, email, user) in a
 * fixed window (e.g. 5 per 15 minutes). Kept in MongoDB, so a lock-out
 * survives an API restart or deploy and is shared if a second API process is
 * ever added (the public rate limits stay in memory: lib/public-limits.ts).
 */
export interface LoginLimiter {
  /** 0 when the key may try again, otherwise seconds until it may. */
  retryAfterSeconds(key: string): Promise<number>;
  recordFailure(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

/**
 * The key is stored only as a SHA-256, so the collection holds no email
 * addresses or IPs. MongoDB deletes a row once its window has ended.
 */
const loginAttemptSchema = new Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true },
    resetAt: { type: Date, required: true },
  },
  { collection: 'loginAttempts', versionKey: false },
);
loginAttemptSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });
export const LoginAttemptModel = model('LoginAttempt', loginAttemptSchema);

const hashKey = (key: string) => createHash('sha256').update(`login-limit:${key}`).digest('hex');

export class MongoLoginLimiter implements LoginLimiter {
  constructor(
    private readonly options: { maxFailures: number; windowMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  async retryAfterSeconds(key: string): Promise<number> {
    const now = this.now();
    const row = await LoginAttemptModel.findById(hashKey(key)).lean();
    if (!row || row.resetAt.getTime() <= now || row.count < this.options.maxFailures) return 0;
    return Math.ceil((row.resetAt.getTime() - now) / 1000);
  }

  /** One atomic write: count up inside a live window, or start a new one. */
  async recordFailure(key: string): Promise<void> {
    const now = new Date(this.now());
    const newReset = new Date(now.getTime() + this.options.windowMs);
    const live = {
      $and: [{ $ne: [{ $type: '$resetAt' }, 'missing'] }, { $gt: ['$resetAt', now] }],
    };
    await LoginAttemptModel.updateOne(
      { _id: hashKey(key) },
      [
        {
          $set: {
            count: { $cond: [live, { $add: ['$count', 1] }, 1] },
            resetAt: { $cond: [live, '$resetAt', newReset] },
          },
        },
      ],
      // Mongoose 9 accepts an aggregation pipeline update only when asked to.
      { upsert: true, updatePipeline: true },
    );
  }

  async reset(key: string): Promise<void> {
    await LoginAttemptModel.deleteOne({ _id: hashKey(key) });
  }
}
