/**
 * Request bodies, queries and public response shapes shared by API and web.
 * Every request body is validated with one of these (CLAUDE.md stack rule).
 */
import { z } from 'zod';
import { ROLES } from '../status.js';
import { objectId, timestamp } from './common.js';

const role = z.enum(ROLES);

/** Trimmed, lower-cased email so "Ops@X.com" and "ops@x.com" are one account. */
export const emailInput = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** New passwords: 12–128 characters. Length beats composition rules. */
export const passwordInput = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters');

export const LoginBodySchema = z.object({
  email: emailInput,
  password: z.string().min(1).max(128),
});

export const TwoFactorBodySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const CreateUserBodySchema = z.object({
  email: emailInput,
  name: z.string().trim().min(1).max(120),
  role,
  password: passwordInput,
});

export const UpdateUserBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: role.optional(),
    active: z.boolean().optional(),
    password: passwordInput.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

export const ListQuerySchema = z.object(paging);

export const AuditQuerySchema = z.object({
  ...paging,
  entityType: z.string().min(1).max(60).optional(),
  entityId: objectId.optional(),
  actorId: objectId.optional(),
  action: z.string().min(1).max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** A staff user as the API returns it. Never includes hashes or secrets. */
export const PublicUserSchema = z.object({
  id: objectId,
  email: z.email(),
  name: z.string(),
  role,
  active: z.boolean(),
  twoFactorEnabled: z.boolean(),
  lastLoginAt: timestamp.nullable(),
  createdAt: timestamp,
});

/**
 * What the client must do after a correct password:
 * done = signed in; 2fa = enter a code; enroll_2fa = set up an authenticator first.
 */
export const LOGIN_NEXT_STEPS = ['done', '2fa', 'enroll_2fa'] as const;
export const LoginResponseSchema = z.object({
  next: z.enum(LOGIN_NEXT_STEPS),
  user: PublicUserSchema.optional(),
});

export const TwoFactorEnrollResponseSchema = z.object({
  otpauthUrl: z.string().startsWith('otpauth://'),
  secret: z.string().min(16),
});

export type LoginBody = z.infer<typeof LoginBodySchema>;
export type TwoFactorBody = z.infer<typeof TwoFactorBodySchema>;
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>;
export type UpdateUserBody = z.infer<typeof UpdateUserBodySchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type LoginNextStep = (typeof LOGIN_NEXT_STEPS)[number];
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type TwoFactorEnrollResponse = z.infer<typeof TwoFactorEnrollResponseSchema>;

export interface Paged<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}
