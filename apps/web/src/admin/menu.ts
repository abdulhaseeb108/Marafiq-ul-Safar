import type { Role } from '@marafiq/shared';

export interface MenuItem {
  to: string;
  /** i18n key for the label. */
  labelKey: string;
  /** Omit for items every staff role may see. */
  roles?: readonly Role[];
}

/**
 * Admin navigation. This only hides links: the API enforces the real
 * permissions on every route. Later phases add their pages here.
 */
export const ADMIN_MENU: readonly MenuItem[] = [
  { to: '/admin', labelKey: 'admin.menu.dashboard' },
  { to: '/admin/users', labelKey: 'admin.menu.users', roles: ['admin'] },
];

export function menuFor(role: Role): MenuItem[] {
  return ADMIN_MENU.filter((item) => !item.roles || item.roles.includes(role));
}
