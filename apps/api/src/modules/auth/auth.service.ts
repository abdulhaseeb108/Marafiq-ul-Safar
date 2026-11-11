import type { LoginBody, Role, TwoFactorEnrollResponse } from '@marafiq/shared';
import mongoose from 'mongoose';
import { generateSecret, generateURI, verify } from 'otplib';
import type { AppConfig } from '../../config/app-config.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { HttpError, rateLimited, unauthenticated } from '../../lib/http-error.js';
import type { FailureLimiter } from '../../lib/rate-limiter.js';
import { recordAudit } from '../audit/audit.service.js';
import { UserModel, type UserDoc } from '../users/user.model.js';
import { burnPasswordCheck, verifyPassword } from './password.js';
import {
  consumeSession,
  findSessionByToken,
  issueSession,
  revokeFamily,
  type SessionTokens,
} from './sessions.service.js';
import { signMfaToken, type MfaPurpose } from './tokens.js';

export interface AuthContext {
  config: AppConfig;
  limiter: FailureLimiter;
}

export type LoginOutcome =
  | { next: 'done'; user: UserDoc; tokens: SessionTokens }
  | { next: '2fa' | 'enroll_2fa'; mfaToken: string };

/** One message for every credential failure, so nothing leaks about accounts. */
const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');

const invalidCode = () => new HttpError(401, 'invalid_code', 'That code is not correct');

const ipKey = (ip: string) => `ip:${ip}`;
const emailKey = (email: string) => `email:${email}`;
const codeKey = (userId: string) => `2fa:${userId}`;

function assertNotLimited(limiter: FailureLimiter, keys: string[]): void {
  const wait = Math.max(...keys.map((key) => limiter.retryAfterSeconds(key)));
  if (wait > 0) throw rateLimited(wait);
}

const sessionUser = (user: UserDoc) => ({ id: user.id as string, role: user.role as Role });

async function completeLogin(
  ctx: AuthContext,
  user: UserDoc,
  mfa: boolean,
  ip: string,
): Promise<SessionTokens> {
  ctx.limiter.reset(emailKey(user.email));
  ctx.limiter.reset(codeKey(user.id as string));
  const tokens = await issueSession(sessionUser(user), mfa, ctx.config);
  user.lastLoginAt = new Date();
  await user.save();
  await recordAudit({
    actor: { id: user.id as string, role: user.role as Role },
    action: 'auth.login_success',
    entityType: 'user',
    entityId: user.id as string,
    after: { twoFactor: mfa },
    ip,
  });
  return tokens;
}

export async function login(ctx: AuthContext, body: LoginBody, ip: string): Promise<LoginOutcome> {
  const keys = [ipKey(ip), emailKey(body.email)];
  assertNotLimited(ctx.limiter, keys);

  const user = await UserModel.findOne({ email: body.email });
  let passwordOk = false;
  if (user) passwordOk = await verifyPassword(user.passwordHash, body.password);
  else await burnPasswordCheck(body.password);

  if (!user || !passwordOk || !user.active) {
    keys.forEach((key) => ctx.limiter.recordFailure(key));
    await recordAudit({
      actor: { role: 'public' },
      action: 'auth.login_failure',
      entityType: 'user',
      entityId: user ? (user.id as string) : undefined,
      // The typed email is not recorded: people paste passwords into that box.
      after: { reason: !user ? 'unknown_email' : !passwordOk ? 'wrong_password' : 'inactive' },
      ip,
    });
    throw invalidCredentials();
  }

  const userId = user.id as string;
  if (user.totpSecretEnc) {
    return { next: '2fa', mfaToken: signMfaToken({ userId, purpose: 'verify' }, ctx.config) };
  }
  if (user.role === 'admin') {
    // 2FA is mandatory for admins: no session until they enroll.
    return {
      next: 'enroll_2fa',
      mfaToken: signMfaToken({ userId, purpose: 'enroll' }, ctx.config),
    };
  }
  return { next: 'done', user, tokens: await completeLogin(ctx, user, false, ip) };
}

async function loadActiveUser(userId: string): Promise<UserDoc> {
  const user = mongoose.isValidObjectId(userId) ? await UserModel.findById(userId) : null;
  if (!user || !user.active) throw unauthenticated();
  return user;
}

/** Generate a TOTP secret and keep it as "pending" until a code proves it. */
export async function startEnrollment(
  ctx: AuthContext,
  userId: string,
  ip: string,
): Promise<TwoFactorEnrollResponse> {
  const user = await loadActiveUser(userId);
  if (user.totpSecretEnc) {
    throw new HttpError(
      409,
      'already_enrolled',
      'Two-factor authentication is already set up. Ask an admin to reset it.',
    );
  }
  const secret = generateSecret();
  user.totpPendingSecretEnc = encryptSecret(secret, ctx.config.totpKey);
  await user.save();
  await recordAudit({
    actor: { id: userId, role: user.role as Role },
    action: 'auth.2fa_enroll_started',
    entityType: 'user',
    entityId: userId,
    ip,
  });
  return {
    otpauthUrl: generateURI({ issuer: ctx.config.totpIssuer, label: user.email, secret }),
    secret,
  };
}

async function codeMatches(secretEnc: string, code: string, key: Buffer): Promise<boolean> {
  try {
    // Accept the neighbouring 30-second step to allow for clock drift.
    const result = await verify({
      secret: decryptSecret(secretEnc, key),
      token: code,
      epochTolerance: 30,
    });
    return result.valid;
  } catch {
    return false;
  }
}

/**
 * Check a TOTP code and start a 2FA session.
 * purpose "verify": second step of login for an enrolled user.
 * purpose "enroll": proves the pending secret, then activates it.
 */
export async function completeTwoFactor(
  ctx: AuthContext,
  input: {
    userId: string;
    purpose: MfaPurpose;
    code: string;
    ip: string;
    /** Set when an already signed-in user enrolls; that session is replaced. */
    replaceFamilyId?: string;
  },
): Promise<{ user: UserDoc; tokens: SessionTokens }> {
  const keys = [ipKey(input.ip), codeKey(input.userId)];
  assertNotLimited(ctx.limiter, keys);

  const user = await loadActiveUser(input.userId);
  const secretEnc = input.purpose === 'enroll' ? user.totpPendingSecretEnc : user.totpSecretEnc;
  if (!secretEnc) {
    throw new HttpError(409, 'enrollment_not_started', 'Start two-factor setup first');
  }

  if (!(await codeMatches(secretEnc, input.code, ctx.config.totpKey))) {
    keys.forEach((key) => ctx.limiter.recordFailure(key));
    await recordAudit({
      actor: { role: 'public' },
      action: 'auth.login_failure',
      entityType: 'user',
      entityId: input.userId,
      after: { reason: 'wrong_2fa_code' },
      ip: input.ip,
    });
    throw invalidCode();
  }

  if (input.purpose === 'enroll') {
    user.totpSecretEnc = secretEnc;
    user.totpPendingSecretEnc = undefined;
    await user.save();
    await recordAudit({
      actor: { id: input.userId, role: user.role as Role },
      action: 'auth.2fa_enabled',
      entityType: 'user',
      entityId: input.userId,
      after: { twoFactorEnabled: true },
      ip: input.ip,
    });
  }

  if (input.replaceFamilyId) await revokeFamily(input.replaceFamilyId);
  return { user, tokens: await completeLogin(ctx, user, true, input.ip) };
}

/** Exchange a refresh token for a new pair. Each refresh token works once. */
export async function refresh(
  ctx: AuthContext,
  refreshToken: string,
  ip: string,
): Promise<{ user: UserDoc; tokens: SessionTokens }> {
  const session = await findSessionByToken(refreshToken, ctx.config);
  if (!session) throw unauthenticated();

  const consumed = !session.revokedAt && (await consumeSession(session));
  if (!consumed) {
    // A used token came back: assume it was stolen and end the whole login.
    await revokeFamily(session.familyId);
    await recordAudit({
      actor: { role: 'public' },
      action: 'auth.refresh_reuse_detected',
      entityType: 'user',
      entityId: String(session.userId),
      ip,
    });
    throw unauthenticated();
  }
  if (session.expiresAt <= new Date()) throw unauthenticated();

  const user = await UserModel.findById(session.userId);
  const adminWithoutMfa = user?.role === 'admin' && !session.mfa;
  if (!user || !user.active || adminWithoutMfa) {
    await revokeFamily(session.familyId);
    throw unauthenticated();
  }
  const tokens = await issueSession(sessionUser(user), session.mfa, ctx.config, session.familyId);
  return { user, tokens };
}

export async function logout(
  ctx: AuthContext,
  input: { refreshToken?: string; familyId?: string; ip: string },
): Promise<void> {
  const session = input.refreshToken
    ? await findSessionByToken(input.refreshToken, ctx.config)
    : null;
  const familyId = session?.familyId ?? input.familyId;
  if (!familyId) return;
  await revokeFamily(familyId);
  if (session) {
    const user = await UserModel.findById(session.userId).select('role').lean();
    await recordAudit({
      actor: { id: String(session.userId), role: (user?.role as Role | undefined) ?? 'public' },
      action: 'auth.logout',
      entityType: 'user',
      entityId: String(session.userId),
      ip: input.ip,
    });
  }
}
