import {
  LoginBodySchema,
  TwoFactorBodySchema,
  type LoginResponse,
  type PublicUser,
  type TwoFactorEnrollResponse,
} from '@marafiq/shared';
import type { Request, Response } from 'express';
import { unauthenticated } from '../../lib/http-error.js';
import { parseOrThrow } from '../../lib/validate.js';
import { getUser, toPublicUser } from '../users/users.service.js';
import { authenticate } from './auth.middleware.js';
import {
  completeTwoFactor,
  login,
  logout,
  refresh,
  startEnrollment,
  type AuthContext,
} from './auth.service.js';
import {
  ACCESS_COOKIE,
  MFA_COOKIE,
  REFRESH_COOKIE,
  clearMfaCookie,
  clearSessionCookies,
  readCookie,
  setMfaCookie,
  setSessionCookies,
} from './cookies.js';
import { verifyAccessToken, verifyMfaToken } from './tokens.js';

const ipOf = (req: Request): string => req.ip ?? 'unknown';

export function makeAuthController(ctx: AuthContext) {
  const { config } = ctx;

  const pendingLogin = (req: Request) => {
    const token = readCookie(req.cookies, MFA_COOKIE);
    return token ? verifyMfaToken(token, config) : null;
  };

  return {
    async login(req: Request, res: Response<LoginResponse>): Promise<void> {
      const body = parseOrThrow(LoginBodySchema, req.body);
      const outcome = await login(ctx, body, ipOf(req));
      if (outcome.next === 'done') {
        clearMfaCookie(res, config);
        setSessionCookies(res, outcome.tokens, config);
        res.json({ next: 'done', user: toPublicUser(outcome.user) });
        return;
      }
      setMfaCookie(res, outcome.mfaToken, config);
      res.json({ next: outcome.next });
    },

    /** Start TOTP setup: after the password step (admins) or while signed in. */
    async enroll(req: Request, res: Response<TwoFactorEnrollResponse>): Promise<void> {
      const pending = pendingLogin(req);
      const session = pending ? null : await authenticate(req, config);
      const userId = pending?.purpose === 'enroll' ? pending.userId : session?.userId;
      if (!userId) throw unauthenticated();
      res.json(await startEnrollment(ctx, userId, ipOf(req)));
    },

    /** Submit a 6-digit code: finishes login, or finishes enrollment. */
    async twoFactor(req: Request, res: Response<LoginResponse>): Promise<void> {
      const pending = pendingLogin(req);
      const session = pending ? null : await authenticate(req, config);
      if (!pending && !session) throw unauthenticated();
      const { code } = parseOrThrow(TwoFactorBodySchema, req.body);

      const { user, tokens } = await completeTwoFactor(ctx, {
        userId: pending?.userId ?? (session?.userId as string),
        purpose: pending?.purpose ?? 'enroll',
        code,
        ip: ipOf(req),
        replaceFamilyId: session?.familyId,
      });
      clearMfaCookie(res, config);
      setSessionCookies(res, tokens, config);
      res.json({ next: 'done', user: toPublicUser(user) });
    },

    async refresh(req: Request, res: Response<{ user: PublicUser }>): Promise<void> {
      const token = readCookie(req.cookies, REFRESH_COOKIE);
      if (!token) throw unauthenticated();
      try {
        const { user, tokens } = await refresh(ctx, token, ipOf(req));
        setSessionCookies(res, tokens, config);
        res.json({ user: toPublicUser(user) });
      } catch (error) {
        clearSessionCookies(res, config);
        throw error;
      }
    },

    /** Always 204, so a client can call it in any state. */
    async logout(req: Request, res: Response): Promise<void> {
      const access = readCookie(req.cookies, ACCESS_COOKIE);
      await logout(ctx, {
        refreshToken: readCookie(req.cookies, REFRESH_COOKIE),
        familyId: access ? verifyAccessToken(access, config)?.familyId : undefined,
        ip: ipOf(req),
      });
      clearSessionCookies(res, config);
      clearMfaCookie(res, config);
      res.status(204).end();
    },

    async me(req: Request, res: Response<PublicUser>): Promise<void> {
      if (!req.auth) throw unauthenticated();
      res.json(await getUser(req.auth.userId));
    },
  };
}
