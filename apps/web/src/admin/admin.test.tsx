import type { PublicUser, Role } from '@marafiq/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import i18n from '../i18n';
import { menuFor } from './menu';

const user = (role: Role): PublicUser => ({
  id: '64b7f0c2a1b2c3d4e5f60718',
  email: `${role}@example.com`,
  name: `Test ${role}`,
  role,
  active: true,
  twoFactorEnabled: role === 'admin',
  lastLoginAt: null,
  createdAt: new Date('2026-11-11T00:00:00Z'),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const unauthenticated = () => json(401, { error: { code: 'unauthenticated', message: 'x' } });

/** Fake API: map "METHOD /path" to a response; anything else is a 401. */
function mockApi(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).replace('/api/v1', '')}`;
    return (routes[key] ?? unauthenticated)();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => vi.unstubAllGlobals());

describe('role-aware menu', () => {
  it('shows Users only to admins', () => {
    expect(menuFor('admin').map((i) => i.to)).toEqual(['/admin', '/admin/users']);
    for (const role of ['sales', 'ops', 'finance'] as const) {
      expect(menuFor(role).map((i) => i.to)).toEqual(['/admin']);
    }
  });

  it('renders the shell without a Users link for sales', async () => {
    mockApi({ 'GET /auth/me': () => json(200, user('sales')) });
    renderAt('/admin');
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('renders the Users link for admins', async () => {
    mockApi({ 'GET /auth/me': () => json(200, user('admin')) });
    renderAt('/admin');
    expect(await screen.findByRole('link', { name: 'Users' })).toBeInTheDocument();
  });
});

describe('admin sign-in', () => {
  it('sends signed-out visitors to the login page', async () => {
    mockApi({});
    renderAt('/admin/users');
    expect(await screen.findByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument();
  });

  it('shows the code step when the API asks for 2FA, then signs in', async () => {
    const fetchMock = mockApi({
      'POST /auth/login': () => json(200, { next: '2fa' }),
      'POST /auth/2fa': () => json(200, { next: 'done', user: user('admin') }),
    });
    const ui = userEvent.setup();
    renderAt('/admin/login');

    await ui.type(await screen.findByLabelText('Email'), 'admin@example.com');
    await ui.type(screen.getByLabelText('Password'), 'correct-horse-battery-1');
    await ui.click(screen.getByRole('button', { name: 'Sign in' }));

    await ui.type(await screen.findByLabelText('6-digit code'), '123456');
    await ui.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('heading', { name: /Welcome, Test admin/ })).toBeInTheDocument();
    const twoFactorCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/2fa'));
    expect(twoFactorCall?.[1]?.body).toBe(JSON.stringify({ code: '123456' }));
  });

  it('shows one translated error for bad credentials', async () => {
    mockApi({
      'POST /auth/login': () => json(401, { error: { code: 'invalid_credentials', message: 'x' } }),
    });
    const ui = userEvent.setup();
    renderAt('/admin/login');
    await ui.type(await screen.findByLabelText('Email'), 'a@example.com');
    await ui.type(screen.getByLabelText('Password'), 'wrong');
    await ui.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

  it('renders the login page in Urdu, right to left', async () => {
    mockApi({});
    await i18n.changeLanguage('ur');
    renderAt('/admin/login');
    expect(await screen.findByRole('heading', { name: 'عملے کا لاگ اِن' })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
  });
});
