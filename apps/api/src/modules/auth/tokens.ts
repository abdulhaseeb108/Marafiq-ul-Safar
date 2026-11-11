import { ROLES, type Role } from '@marafiq/shared';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { AppConfig } from '../../config/app-config.js';

const ALGORITHM = 'HS256' as const;

const AccessPayload = z.object({
  typ: z.literal('access'),
  sub: z.string(),
  role: z.enum(ROLES),
  mfa: z.boolean(),
  sid: z.string(),
});
export interface AccessClaims {
  userId: string;
  role: Role;
  mfa: boolean;
  familyId: string;
}

const MfaPayload = z.object({
  typ: z.literal('mfa'),
  sub: z.string(),
  purpose: z.enum(['verify', 'enroll']),
});
export type MfaPurpose = 'verify' | 'enroll';
export interface MfaClaims {
  userId: string;
  purpose: MfaPurpose;
}

function verify(token: string, secret: string): unknown {
  try {
    return jwt.verify(token, secret, { algorithms: [ALGORITHM] });
  } catch {
    return null; // expired, bad signature or malformed
  }
}

export function signAccessToken(claims: AccessClaims, config: AppConfig): string {
  return jwt.sign(
    { typ: 'access', role: claims.role, mfa: claims.mfa, sid: claims.familyId },
    config.jwtSecret,
    { algorithm: ALGORITHM, subject: claims.userId, expiresIn: config.accessTtlSeconds },
  );
}

export function verifyAccessToken(token: string, config: AppConfig): AccessClaims | null {
  const parsed = AccessPayload.safeParse(verify(token, config.jwtSecret));
  if (!parsed.success) return null;
  const { sub, role, mfa, sid } = parsed.data;
  return { userId: sub, role, mfa, familyId: sid };
}

/** Short-lived proof that the password step passed; grants nothing else. */
export function signMfaToken(claims: MfaClaims, config: AppConfig): string {
  return jwt.sign({ typ: 'mfa', purpose: claims.purpose }, config.jwtSecret, {
    algorithm: ALGORITHM,
    subject: claims.userId,
    expiresIn: config.mfaTtlSeconds,
  });
}

export function verifyMfaToken(token: string, config: AppConfig): MfaClaims | null {
  const parsed = MfaPayload.safeParse(verify(token, config.jwtSecret));
  if (!parsed.success) return null;
  return { userId: parsed.data.sub, purpose: parsed.data.purpose };
}
