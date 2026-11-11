import { randomUUID } from 'node:crypto';
import type { Role } from '@marafiq/shared';
import type { AppConfig } from '../../config/app-config.js';
import { hashToken, randomToken } from '../../lib/crypto.js';
import { SessionModel, type SessionDoc } from './session.model.js';
import { signAccessToken } from './tokens.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  familyId: string;
}

interface SessionUser {
  id: string;
  role: Role;
}

/** Create a session row and both tokens. Pass familyId when rotating. */
export async function issueSession(
  user: SessionUser,
  mfa: boolean,
  config: AppConfig,
  familyId: string = randomUUID(),
): Promise<SessionTokens> {
  const refreshToken = randomToken();
  await SessionModel.create({
    userId: user.id,
    familyId,
    tokenHash: hashToken(refreshToken, config.refreshSecret),
    mfa,
    expiresAt: new Date(Date.now() + config.refreshTtlSeconds * 1000),
  });
  const accessToken = signAccessToken({ userId: user.id, role: user.role, mfa, familyId }, config);
  return { accessToken, refreshToken, familyId };
}

export function findSessionByToken(
  refreshToken: string,
  config: AppConfig,
): Promise<SessionDoc | null> {
  return SessionModel.findOne({ tokenHash: hashToken(refreshToken, config.refreshSecret) });
}

/**
 * Mark one refresh token as used. Returns false if it was already used or
 * revoked, which means the token was replayed.
 */
export async function consumeSession(session: SessionDoc): Promise<boolean> {
  const updated = await SessionModel.findOneAndUpdate(
    { _id: session._id, revokedAt: null },
    { revokedAt: new Date() },
  );
  return updated !== null;
}

export async function revokeFamily(familyId: string): Promise<void> {
  await SessionModel.updateMany({ familyId, revokedAt: null }, { revokedAt: new Date() });
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await SessionModel.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() });
}

/** True while the login this access token belongs to has not been logged out. */
export async function isFamilyLive(familyId: string): Promise<boolean> {
  const live = await SessionModel.exists({
    familyId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  return live !== null;
}
