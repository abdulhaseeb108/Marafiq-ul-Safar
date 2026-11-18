import type { PublicUser, Role } from '@marafiq/shared';
import { render, screen, within } from '@testing-library/react';
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
      '/admin/rate-sheets',
      '/admin/hotels',
      '/admin/suppliers',
      '/admin/flight-estimates',
      '/admin/fx',
      '/admin/settings',
      '/admin/users',
    ]);
    expect(menuFor('ops').map((i) => i.to)).toEqual([
      '/admin',
      '/admin/rate-sheets',
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
    for (const hidden of ['Users', 'Settings', 'Exchange rate', 'Suppliers', 'Rate sheets']) {
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

describe('rate sheet review', () => {
  const PACK_ID = '64b7f0c2a1b2c3d4e5f60aaa';
  const RATE_ID = '64b7f0c2a1b2c3d4e5f60bbb';
  const DOC_ID = '64b7f0c2a1b2c3d4e5f60ccc';
  const paged = (items: unknown[]) => json(200, { items, page: 1, limit: 50, total: items.length });

  const pack = (overrides: Record<string, unknown> = {}) => ({
    id: PACK_ID,
    supplierId: 's1',
    sourceDocumentId: DOC_ID,
    supplierName: 'Waqar-e-Madina Group (WMT)',
    packName: 'Ramadan Pack 01',
    seasonLabel: 'Ramadan',
    nightFrom: '2027-02-06',
    nightTo: '2027-02-26',
    issueDate: '2026-10-27',
    effectiveFrom: '2026-10-27',
    currency: 'SAR',
    status: 'needs_review',
    version: 1,
    blockingCount: 0,
    warningCount: 0,
    publishedAt: null,
    publishedByName: null,
    supersedesId: null,
    validation: { blocking: [], warnings: [] },
    visa: {
      directPerPersonMinor: 55_000,
      indirectByGroupSizeMinor: { '1': 70_000, '2': 67_500, '3': 65_000, '4': 62_500 },
      infantMinor: 46_000,
      appliesNote: null,
    },
    rates: [
      {
        id: RATE_ID,
        packageId: PACK_ID,
        hotelId: 'h1',
        hotelName: 'Qila Ajiyad',
        printed: {
          city: 'makkah',
          name: 'QILA AJIYAD',
          aliases: [],
          distanceText: null,
          distanceMeters: 1100,
          transportText: null,
        },
        suggestedHotelId: null,
        suggestedHotelName: null,
        pricingMode: 'derived_per_person',
        roomPriceMinor: 20_000,
        perPersonMinor: { quint: 4000, quad: 5000, triple: 6700, double: 10_000 },
        flatNote: null,
        sourcePage: 1,
        sourceRow: 3,
        confidence: 0.99,
        edited: false,
      },
    ],
    replaceable: [],
    canRollback: false,
    ...overrides,
  });

  const routes = (detail: unknown, extra: Record<string, () => Response> = {}) => ({
    'GET /auth/me': () => json(200, user('ops')),
    [`GET /admin/rate-packages/${PACK_ID}`]: () => json(200, detail),
    [`GET /admin/source-documents/${DOC_ID}`]: () =>
      json(200, { id: DOC_ID, mimeType: 'application/pdf', fileName: 'sheet.pdf', packages: [] }),
    'GET /admin/hotels?limit=200': () => paged([]),
    ...extra,
  });

  it('shows the original beside the figures, in SAR', async () => {
    mockApi(routes(pack()));
    renderAt(`/admin/rate-sheets/${PACK_ID}`);

    expect(await screen.findByRole('heading', { name: 'Ramadan Pack 01' })).toBeInTheDocument();
    expect(await screen.findByTitle('Original sheet')).toHaveAttribute(
      'src',
      `/api/v1/admin/source-documents/${DOC_ID}/file`,
    );
    expect(screen.getByLabelText('Room price for Qila Ajiyad')).toHaveValue('200');
    expect(screen.getByLabelText('Triple price for Qila Ajiyad')).toHaveValue('67');
    expect(screen.getByLabelText('Direct flight')).toHaveValue('550');
  });

  it('cannot publish while a blocking problem exists, and shows it on its row', async () => {
    const blocked = pack({
      validation: {
        blocking: [
          {
            code: 'derived_without_room',
            message: '"Qila Ajiyad" has no room price.',
            path: `rate:${RATE_ID}`,
          },
        ],
        warnings: [],
      },
    });
    mockApi(routes(blocked));
    renderAt(`/admin/rate-sheets/${PACK_ID}`);

    expect(
      await screen.findByText('1 problem must be fixed before publishing'),
    ).toBeInTheDocument();
    expect(screen.getByText('"Qila Ajiyad" has no room price.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish these rates' })).toBeDisabled();
  });

  it('makes staff tick the warnings before publishing, and sends that with the request', async () => {
    const warned = pack({
      validation: {
        blocking: [],
        warnings: [
          { code: 'issue_date_old', message: 'The sheet was issued long ago.', path: 'header' },
        ],
      },
    });
    const fetchMock = mockApi(
      routes(warned, {
        [`POST /admin/rate-packages/${PACK_ID}/publish`]: () =>
          json(200, pack({ status: 'published' })),
      }),
    );
    const ui = userEvent.setup();
    renderAt(`/admin/rate-sheets/${PACK_ID}`);

    const publish = await screen.findByRole('button', { name: 'Publish these rates' });
    expect(publish).toBeDisabled();
    await ui.click(screen.getByRole('checkbox'));
    await ui.click(publish);

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/publish'));
    expect(call?.[1]?.body).toBe(JSON.stringify({ acknowledgeWarnings: true }));
    // Once published, the figures are read-only.
    expect(await screen.findByText(/can no longer be edited/)).toBeInTheDocument();
    expect(screen.getByLabelText('Room price for Qila Ajiyad')).toBeDisabled();
  });

  it('saves an edited figure in halalas when the cursor leaves the box', async () => {
    const fetchMock = mockApi(
      routes(pack(), { [`PATCH /admin/hotel-rates/${RATE_ID}`]: () => json(200, pack()) }),
    );
    const ui = userEvent.setup();
    renderAt(`/admin/rate-sheets/${PACK_ID}`);

    const room = await screen.findByLabelText('Room price for Qila Ajiyad');
    await ui.clear(room);
    await ui.type(room, '210.50');
    await ui.tab();

    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(call?.[1]?.body).toBe(JSON.stringify({ roomPriceMinor: 21_050 }));
  });

  it('lists uploaded sheets with their packs and says when reading failed', async () => {
    mockApi({
      'GET /auth/me': () => json(200, user('ops')),
      'GET /admin/suppliers?limit=100': () => paged([{ id: 's1', name: 'WMT', active: true }]),
      'GET /admin/source-documents?limit=50': () =>
        paged([
          {
            id: DOC_ID,
            supplierName: 'WMT',
            fileName: 'WMT_RAMADAN.pdf',
            receivedAt: '2026-11-12T00:00:00.000Z',
            uploadedByName: 'Test ops',
            extractionStatus: 'needs_review',
            extractionError: 'Extraction failed — enter manually or retry',
            packages: [
              {
                id: PACK_ID,
                packName: 'Shawal',
                nightFrom: '2027-03-11',
                nightTo: '2027-04-06',
                status: 'needs_review',
                version: 1,
                blockingCount: 2,
                warningCount: 1,
              },
            ],
          },
        ]),
    });
    renderAt('/admin/rate-sheets');

    expect(await screen.findByText('WMT_RAMADAN.pdf')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('could not be read automatically');
    expect(screen.getByRole('link', { name: 'Shawal' })).toHaveAttribute(
      'href',
      `/admin/rate-sheets/${PACK_ID}`,
    );
    expect(screen.getByText('2 problems')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read it again' })).toBeInTheDocument();
  });
});

describe('duplicate rate-sheet upload', () => {
  const DOC_ID = '64b7f0c2a1b2c3d4e5f60ccc';
  const PACK_ID = '64b7f0c2a1b2c3d4e5f60aaa';
  const paged = (items: unknown[]) => json(200, { items, page: 1, limit: 50, total: items.length });
  const existing = {
    id: DOC_ID,
    supplierName: 'Waqar-e-Madina Group (WMT)',
    fileName: 'WMT RAMADAN 2027.pdf',
    receivedAt: '2026-11-12T04:45:00.000Z',
    uploadedByName: 'Administrator',
    extractionStatus: 'needs_review',
    extractionError: null,
    packages: [
      {
        id: PACK_ID,
        packName: 'WMT RAMADAN',
        nightFrom: null,
        nightTo: null,
        status: 'needs_review',
        version: 1,
        blockingCount: 2,
        warningCount: 2,
      },
    ],
  };
  const base = {
    'GET /auth/me': () => json(200, user('ops')),
    'GET /admin/suppliers?limit=100': () =>
      paged([{ id: 's1', name: 'Waqar-e-Madina Group (WMT)', active: true }]),
    'GET /admin/source-documents?limit=50': () => paged([existing]),
  };

  it('says the file is already here and links to the existing document and its pack', async () => {
    const fetchMock = mockApi({
      ...base,
      'POST /admin/source-documents': () =>
        json(409, {
          error: {
            code: 'duplicate_document',
            message:
              'This exact file was already uploaded for this supplier as "WMT RAMADAN 2027.pdf".',
            fields: {
              existingId: DOC_ID,
              existingFileName: 'WMT RAMADAN 2027.pdf',
              existingReceivedAt: '2026-11-12T04:45:00.000Z',
            },
          },
        }),
    });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const ui = userEvent.setup();
    renderAt('/admin/rate-sheets');

    const input = await screen.findByLabelText('Rate sheet file');
    await ui.upload(
      input,
      new File(['%PDF-1.4 same bytes'], 'WMT RAMADAN 2027 (1).pdf', { type: 'application/pdf' }),
    );
    await ui.click(screen.getByRole('button', { name: 'Upload' }));

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('This file is already here. Nothing was uploaded.');
    expect(notice).toHaveTextContent('“WMT RAMADAN 2027.pdf”');
    expect(within(notice).getByRole('link', { name: 'Open the stored file' })).toHaveAttribute(
      'href',
      `/api/v1/admin/source-documents/${DOC_ID}/file`,
    );
    expect(within(notice).getByRole('link', { name: 'Open pack “WMT RAMADAN”' })).toHaveAttribute(
      'href',
      `/admin/rate-sheets/${PACK_ID}`,
    );

    await ui.click(within(notice).getByRole('link', { name: 'Show it in the list below' }));
    expect(scrolled).toHaveBeenCalled();
    expect(document.getElementById(`sheet-${DOC_ID}`)?.className).toContain('ring-2');

    // The refused file is dropped from the form, and exactly one upload was sent.
    expect((input as HTMLInputElement).files).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('links to the existing pack when the same pack is entered by hand again', async () => {
    mockApi({
      ...base,
      [`POST /admin/source-documents/${DOC_ID}/rate-packages`]: () =>
        json(409, {
          error: {
            code: 'pack_name_taken',
            message: 'x',
            fields: { existingId: PACK_ID, existingPackName: 'WMT RAMADAN' },
          },
        }),
    });
    const ui = userEvent.setup();
    renderAt('/admin/rate-sheets');

    await ui.click(await screen.findByRole('button', { name: 'Enter by hand' }));
    await ui.type(screen.getByLabelText('Pack name, as printed'), 'WMT RAMADAN');
    await ui.click(screen.getByRole('button', { name: 'Start entering' }));

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('already has a pack called “WMT RAMADAN”');
    expect(within(notice).getByRole('link', { name: 'Open the existing pack' })).toHaveAttribute(
      'href',
      `/admin/rate-sheets/${PACK_ID}`,
    );
  });
});
