import type {
  CreateUserBody,
  ListQuery,
  Paged,
  PublicUser,
  Role,
  UpdateUserBody,
} from '@marafiq/shared';
import mongoose from 'mongoose';
import { HttpError, notFound } from '../../lib/http-error.js';
import { recordAudit, type ActorRole } from '../audit/audit.service.js';
import { hashPassword } from '../auth/password.js';
import { revokeUserSessions } from '../auth/sessions.service.js';
import { UserModel, type UserDoc } from './user.model.js';

export interface Actor {
  id?: string;
  role: ActorRole;
  ip?: string;
}

/** The only shape of a user that leaves the API. No hash, no secrets. */
export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: user.id as string,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    active: user.active,
    twoFactorEnabled: Boolean(user.totpSecretEnc),
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
  };
}

/** What audit events record about a user: enough to see the change, nothing secret. */
function auditSnapshot(user: UserDoc) {
  const { email, name, role, active, twoFactorEnabled } = toPublicUser(user);
  return { email, name, role, active, twoFactorEnabled };
}

async function findUserOr404(id: string): Promise<UserDoc> {
  const user = mongoose.isValidObjectId(id) ? await UserModel.findById(id) : null;
  if (!user) throw notFound('User');
  return user;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

const emailTaken = () => new HttpError(409, 'email_taken', 'A user with this email already exists');

export async function createUser(body: CreateUserBody, actor: Actor): Promise<PublicUser> {
  if (await UserModel.exists({ email: body.email })) throw emailTaken();
  let user: UserDoc;
  try {
    user = await UserModel.create({
      email: body.email,
      name: body.name,
      role: body.role,
      passwordHash: await hashPassword(body.password),
      active: true,
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw emailTaken(); // lost a race with another create
    throw error;
  }
  await recordAudit({
    actor,
    action: actor.role === 'system' ? 'user.seed' : 'user.create',
    entityType: 'user',
    entityId: user.id as string,
    after: auditSnapshot(user),
    ip: actor.ip,
  });
  return toPublicUser(user);
}

export async function listUsers(query: ListQuery): Promise<Paged<PublicUser>> {
  const [users, total] = await Promise.all([
    UserModel.find()
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    UserModel.countDocuments(),
  ]);
  return { items: users.map(toPublicUser), page: query.page, limit: query.limit, total };
}

export async function getUser(id: string): Promise<PublicUser> {
  return toPublicUser(await findUserOr404(id));
}

export async function updateUser(
  id: string,
  body: UpdateUserBody,
  actor: Actor,
): Promise<PublicUser> {
  const user = await findUserOr404(id);
  const before = auditSnapshot(user);

  const isSelf = actor.id === user.id;
  const losesAdmin = body.role !== undefined && body.role !== 'admin' && user.role === 'admin';
  if (isSelf && (body.active === false || losesAdmin)) {
    // Also guarantees there is always at least one active admin.
    throw new HttpError(
      400,
      'cannot_modify_self',
      'You cannot deactivate or demote your own account. Ask another admin.',
    );
  }

  if (body.name !== undefined) user.name = body.name;
  if (body.role !== undefined) user.role = body.role;
  if (body.active !== undefined) user.active = body.active;
  if (body.password !== undefined) user.passwordHash = await hashPassword(body.password);
  await user.save();

  // A deactivated user, or one whose password changed, loses every live session.
  if (body.active === false || body.password !== undefined) {
    await revokeUserSessions(user.id as string);
  }

  let action = 'user.update';
  if (body.active !== undefined && body.active !== before.active) {
    action = body.active ? 'user.reactivate' : 'user.deactivate';
  }
  await recordAudit({
    actor,
    action,
    entityType: 'user',
    entityId: user.id as string,
    before,
    after: {
      ...auditSnapshot(user),
      ...(body.password !== undefined ? { credentialChanged: true } : {}),
    },
    ip: actor.ip,
  });
  return toPublicUser(user);
}

export function deactivateUser(id: string, actor: Actor): Promise<PublicUser> {
  return updateUser(id, { active: false }, actor);
}

/** For a lost phone. The user must enroll again (admins: before any admin access). */
export async function resetTwoFactor(id: string, actor: Actor): Promise<PublicUser> {
  const user = await findUserOr404(id);
  const before = auditSnapshot(user);
  user.totpSecretEnc = undefined;
  user.totpPendingSecretEnc = undefined;
  await user.save();
  await revokeUserSessions(user.id as string);
  await recordAudit({
    actor,
    action: 'auth.2fa_reset',
    entityType: 'user',
    entityId: user.id as string,
    before,
    after: auditSnapshot(user),
    ip: actor.ip,
  });
  return toPublicUser(user);
}
