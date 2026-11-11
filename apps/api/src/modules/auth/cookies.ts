import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../../config/app-config.js';
import type { SessionTokens } from './sessions.service.js';

export const ACCESS_COOKIE = 'msf_access';
export const REFRESH_COOKIE = 'msf_refresh';
export const MFA_COOKIE = 'msf_mfa';

const API_PATH = '/api/v1';
const AUTH_PATH = '/api/v1/auth';

/** httpOnly: scripts cannot read it. sameSite strict: other sites cannot send it. */
function baseOptions(config: AppConfig, path: string): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  };
}

export function setSessionCookies(res: Response, tokens: SessionTokens, config: AppConfig): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...baseOptions(config, API_PATH),
    maxAge: config.accessTtlSeconds * 1000,
  });
  // The refresh token is only ever sent to the auth endpoints.
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseOptions(config, AUTH_PATH),
    maxAge: config.refreshTtlSeconds * 1000,
  });
}

export function clearSessionCookies(res: Response, config: AppConfig): void {
  res.clearCookie(ACCESS_COOKIE, baseOptions(config, API_PATH));
  res.clearCookie(REFRESH_COOKIE, baseOptions(config, AUTH_PATH));
}

export function setMfaCookie(res: Response, token: string, config: AppConfig): void {
  res.cookie(MFA_COOKIE, token, {
    ...baseOptions(config, AUTH_PATH),
    maxAge: config.mfaTtlSeconds * 1000,
  });
}

export function clearMfaCookie(res: Response, config: AppConfig): void {
  res.clearCookie(MFA_COOKIE, baseOptions(config, AUTH_PATH));
}

export function readCookie(cookies: unknown, name: string): string | undefined {
  const value = (cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
