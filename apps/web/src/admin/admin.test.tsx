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
  it('gives each role exactly the pages it may use (docs/02 section 3)', () => {
    expect(menuFor('admin').map((i) => i.to)).toEqual([
      '/admin',
      '/admin/hotels',
      '/admin/suppliers',
      '/admin/flight-estimates',
      '/admin/fx',
      '/admin/settings',
      '/admin/users',
    ]);
    expect(menuFor('ops').map((i) => i.to)).toEqual([
      '/admin',
      '/admin/hotels',
      '/admin/suppliers',
      '/admin/flight-estimates',
    ]);
    // Sales and finance read hotels for quotes but change no master data.
    for (const role of ['sales', 'finance'] as const) {
      expect(menuFor(role).map((i) => i.to)).toEqual(['/admin', '/admin/hotels']);
    }
  });

  it('renders the shell without admin-only links for sales', async () => {
    mockApi({ 'GET /auth/me': () => json(200, user('sales')) });
    renderAt('/admin');
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Hotels' })).toBeInTheDocument();
    for (const hidden of ['Users', 'Settings', 'Exchange rate', 'Suppliers']) {
      expect(screen.queryByRole('link', { name: hidden })).not.toBeInTheDocument();
    }
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

describe('master data pages', () => {
  const paged = (items: unknown[]) => json(200, { items, page: 1, limit: 50, total: items.length });

  it('shows hotels with their other names, and hides editing from sales', async () => {
    mockApi({
      'GET /auth/me': () => json(200, user('sales')),
      'GET /admin/hotels?limit=200&includeInactive=true': () =>
        paged([
          {
            id: '64b7f0c2a1b2c3d4e5f60711',
            city: 'makkah',
            canonicalName: 'Rose Platinum',
            aliases: ['Retaj Rawdah'],
            distanceMeters: 450,
            distanceNote: 'Shahra Ajiad',
            transport: 'shuttle',
            starRating: null,
            active: true,
            mergedIntoId: null,
            createdAt: '2026-11-11T00:00:00.000Z',
          },
        ]),
    });
    renderAt('/admin/hotels');
    expect(await screen.findByText('Rose Platinum')).toBeInTheDocument();
    expect(screen.getByText(/Retaj Rawdah/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add hotel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
  });

  it('asks an admin to confirm a large exchange-rate change, then saves it', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': () => json(200, user('admin')),
      'GET /admin/fx': () =>
        paged([
          {
            id: '64b7f0c2a1b2c3d4e5f60712',
            base: 'SAR',
            quote: 'PKR',
            rate: '75.00',
            effectiveAt: '2026-11-01T00:00:00.000Z',
            setBy: null,
            setByName: null,
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        ]),
      'POST /admin/fx': () => json(409, { error: { code: 'large_fx_change', message: 'x' } }),
    });
    const ui = userEvent.setup();
    renderAt('/admin/fx');

    await ui.type(await screen.findByLabelText('PKR per 1 SAR'), '150.00');
    await ui.click(screen.getByRole('button', { name: 'Save rate' }));

    expect(await screen.findByText(/That is a big change/)).toBeInTheDocument();
    expect(screen.getByText(/differs from the current rate \(75.00\)/)).toBeInTheDocument();

    await ui.click(screen.getByRole('button', { name: 'Yes, save this rate' }));
    const confirmed = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/admin/fx'))
      .map(([, init]) => init?.body);
    expect(confirmed).toContain(JSON.stringify({ rate: '150.00', confirmLargeChange: true }));
  });

  it('converts rupees to paisa when adding a flight estimate', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': () => json(200, user('ops')),
      'GET /admin/flight-estimates': () => paged([]),
      'POST /admin/flight-estimates': () => json(201, {}),
    });
    const ui = userEvent.setup();
    renderAt('/admin/flight-estimates');

    await ui.type(await screen.findByLabelText('Departure city'), 'Islamabad');
    await ui.type(screen.getByLabelText('Low (PKR per adult)'), '150,000');
    await ui.type(screen.getByLabelText('High (PKR per adult)'), '210000');
    await ui.type(screen.getByLabelText('Valid until'), '2027-01-31');
    await ui.type(screen.getByLabelText('Source'), 'partner quote');
    await ui.click(screen.getByRole('button', { name: 'Add estimate' }));

    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      originCity: 'Islamabad',
      lowMinor: 15_000_000,
      highMinor: 21_000_000,
    });
  });
});
