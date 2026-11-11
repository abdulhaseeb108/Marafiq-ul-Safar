import type { Role } from '@marafiq/shared';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      auth?: {
        userId: string;
        role: Role;
        /** True when this session passed the TOTP step. */
        mfa: boolean;
        /** Session family; all rotated refresh tokens of one login share it. */
        familyId: string;
      };
    }
  }
}

export {};
