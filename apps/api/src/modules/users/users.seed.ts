import { emailInput, passwordInput } from '@marafiq/shared';
import { UserModel } from './user.model.js';
import { createUser } from './users.service.js';

export type SeedResult = 'created' | 'skipped_not_configured' | 'skipped_users_exist';

/**
 * Create the first admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD, only
 * when the users collection is empty. The admin has no 2FA yet and must enroll
 * at first sign-in before any admin route opens.
 */
export async function seedFirstAdmin(env: {
  SEED_ADMIN_EMAIL?: string;
  SEED_ADMIN_PASSWORD?: string;
}): Promise<SeedResult> {
  if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) return 'skipped_not_configured';
  if ((await UserModel.estimatedDocumentCount()) > 0) return 'skipped_users_exist';

  const email = emailInput.safeParse(env.SEED_ADMIN_EMAIL);
  const password = passwordInput.safeParse(env.SEED_ADMIN_PASSWORD);
  if (!email.success) throw new Error('SEED_ADMIN_EMAIL is not a valid email address');
  if (!password.success) throw new Error('SEED_ADMIN_PASSWORD must be 12 to 128 characters');

  await createUser(
    { email: email.data, name: 'Administrator', role: 'admin', password: password.data },
    { role: 'system' },
  );
  return 'created';
}
