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
 * permissions on every route (docs/02 section 3). Later phases add their
 * pages here.
 */
export const ADMIN_MENU: readonly MenuItem[] = [
  { to: '/admin', labelKey: 'admin.menu.dashboard' },
  { to: '/admin/hotels', labelKey: 'admin.menu.hotels' },
  { to: '/admin/suppliers', labelKey: 'admin.menu.suppliers', roles: ['admin', 'ops'] },
  { to: '/admin/flight-estimates', labelKey: 'admin.menu.flights', roles: ['admin', 'ops'] },
  { to: '/admin/fx', labelKey: 'admin.menu.fx', roles: ['admin'] },
  { to: '/admin/settings', labelKey: 'admin.menu.settings', roles: ['admin'] },
  { to: '/admin/users', labelKey: 'admin.menu.users', roles: ['admin'] },
];

export function menuFor(role: Role): MenuItem[] {
  return ADMIN_MENU.filter((item) => !item.roles || item.roles.includes(role));
}
