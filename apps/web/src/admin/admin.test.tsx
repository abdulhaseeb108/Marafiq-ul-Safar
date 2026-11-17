import type { DashboardSummary, PublicUser, Role } from '@marafiq/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import i18n from '../i18n';
import en from '../locales/en.json';
import ur from '../locales/ur.json';
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
      '/admin/leads',
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
      '/admin/leads',
      '/admin/rate-sheets',
      '/admin/hotels',
      '/admin/suppliers',
      '/admin/flight-estimates',
    ]);
    // Sales and finance read hotels for quotes but change no master data.
    for (const role of ['sales', 'finance'] as const) {
      expect(menuFor(role).map((i) => i.to)).toEqual(['/admin', '/admin/leads', '/admin/hotels']);
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

describe('leads and quotes (Phase 6)', () => {
  const LEAD = '64b7f0c2a1b2c3d4e5f6a001';
  const QUOTE = '64b7f0c2a1b2c3d4e5f6b001';
  const leadSummary = {
    id: LEAD,
    reference: 'MSF-2026-000001',
    status: 'new',
    source: 'umrah',
    travelerName: 'Aisha Khan',
    phone: '0300 1234567',
    assignedTo: null,
    createdAt: '2026-11-13T05:00:00.000Z',
    latestQuote: null,
  };
  const leadDetail = (extra: object = {}) => ({
    ...leadSummary,
    traveler: { name: 'Aisha Khan', phone: '0300 1234567', email: null, language: 'ur' },
    notesText: 'Prefer a lower floor',
    consent: { textVersion: '2026-11-v1', acceptedAt: '2026-11-13T05:00:00.000Z' },
    tripInputs: null,
    calculation: null,
    notes: [],
    messages: [
      {
        id: 'm1',
        direction: 'inbound',
        channel: 'site',
        body: 'Can we have a higher floor?',
        byName: null,
        createdAt: '2026-11-13T06:00:00.000Z',
      },
    ],
    quotes: [],
    nextStatuses: ['contacted', 'lost'],
    ...extra,
  });
  const draft = {
    id: QUOTE,
    leadId: LEAD,
    reference: 'MSF-2026-000001',
    version: 1,
    status: 'draft',
    lineItems: [
      {
        description: 'Qila Ajiyad (Makkah), quad, 3 nights',
        supplier: 'WMT',
        quantity: 12,
        unitAmountMinor: 5_000,
        currency: 'SAR',
        notes: '',
        amountMinor: 60_000,
        amountMinorSAR: 60_000,
        amountMinorPKR: 4_500_000,
      },
    ],
    exclusions: ['Meals'],
    terms: 'Terms',
    fx: { rate: '75.00', effectiveAt: '2026-11-01T00:00:00.000Z' },
    totals: { totalMinorPKR: 4_500_000, totalMinorSAR: 60_000 },
    expiresAt: '2026-11-16T18:59:59.999Z',
    sentAt: null,
    acceptedAt: null,
    previousId: null,
    replacedById: null,
    history: [],
    missingFromCalculation: ['Flight: request a quote'],
  };

  it('lists leads with staff status words', async () => {
    mockApi({
      'GET /auth/me': () => json(200, user('ops')),
      'GET /admin/leads?page=1&limit=25': () =>
        json(200, { items: [leadSummary], page: 1, limit: 25, total: 1 }),
    });
    renderAt('/admin/leads');
    const link = await screen.findByRole('link', { name: 'MSF-2026-000001' });
    expect(link).toHaveAttribute('href', `/admin/leads/${LEAD}`);
    const row = link.closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Aisha Khan');
    expect(row).toHaveTextContent('New');
  });

  it('ops reads a lead but gets no pipeline, notes or quote buttons', async () => {
    mockApi({
      'GET /auth/me': () => json(200, user('ops')),
      [`GET /admin/leads/${LEAD}`]: () => json(200, { ...leadDetail(), quotes: undefined }),
    });
    renderAt(`/admin/leads/${LEAD}`);
    expect(await screen.findByText('Can we have a higher floor?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create quote' })).not.toBeInTheDocument();
  });

  it('sales moves a lead, then creates a quote and lands in the builder', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': () => json(200, user('sales')),
      [`GET /admin/leads/${LEAD}`]: () => json(200, leadDetail()),
      'GET /admin/leads/assignees': () =>
        json(200, { items: [{ id: 'u1', name: 'Bilal', role: 'sales' }] }),
      [`PATCH /admin/leads/${LEAD}`]: () =>
        json(200, leadDetail({ status: 'contacted', nextStatuses: ['quote_in_progress', 'lost'] })),
      [`POST /admin/leads/${LEAD}/quotes`]: () => json(201, draft),
      [`GET /admin/quotes/${QUOTE}`]: () => json(200, draft),
    });
    const ui = userEvent.setup();
    renderAt(`/admin/leads/${LEAD}`);
    await ui.click(await screen.findByRole('button', { name: 'Move to: Contacted' }));
    expect(
      await screen.findByRole('heading', { name: 'MSF-2026-000001 · Contacted' }),
    ).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ status: 'contacted' });

    await ui.click(screen.getByRole('button', { name: 'Create quote' }));
    expect(await screen.findByRole('heading', { name: /quote version 1/ })).toBeInTheDocument();
    expect(screen.getByText('Flight: request a quote')).toBeInTheDocument();
  });

  it('the builder saves prices as minor units, then sends and shows the link once', async () => {
    const saved = {
      ...draft,
      lineItems: [
        {
          ...draft.lineItems[0],
          unitAmountMinor: 5_550,
          amountMinor: 66_600,
          amountMinorSAR: 66_600,
          amountMinorPKR: 4_995_000,
        },
      ],
      totals: { totalMinorPKR: 4_995_000, totalMinorSAR: 66_600 },
    };
    const fetchMock = mockApi({
      'GET /auth/me': () => json(200, user('sales')),
      [`GET /admin/quotes/${QUOTE}`]: () => json(200, draft),
      [`PUT /admin/quotes/${QUOTE}`]: () => json(200, saved),
      [`POST /admin/quotes/${QUOTE}/send`]: () =>
        json(200, {
          link: `https://site.test/q/${'x'.repeat(43)}`,
          emailed: false,
          quote: { ...saved, status: 'sent', sentAt: '2026-11-13T07:00:00.000Z' },
        }),
    });
    const ui = userEvent.setup();
    renderAt(`/admin/quotes/${QUOTE}`);
    const unit = await screen.findByLabelText('Unit price');
    await ui.clear(unit);
    await ui.type(unit, '55.50');
    expect(screen.getByRole('button', { name: 'Send to customer' })).toBeDisabled();
    await ui.click(screen.getByRole('button', { name: 'Save draft' }));

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).lineItems[0]).toMatchObject({
      quantity: 12,
      unitAmountMinor: 5_550,
      currency: 'SAR',
    });
    expect(await screen.findByText('PKR 49,950 · SAR 666')).toBeInTheDocument();

    await ui.click(screen.getByRole('button', { name: 'Send to customer' }));
    expect(await screen.findByLabelText('Private link')).toHaveValue(
      `https://site.test/q/${'x'.repeat(43)}`,
    );
    expect(screen.getByText('No email on file: send this link on WhatsApp.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make a new version' })).toBeInTheDocument();
  });

  // Phase 6 review: the API refuses these with a code; staff must be told why,
  // in their language, not "Something went wrong".
  describe('quote conflicts are explained to staff', () => {
    const OTHER = '64b7f0c2a1b2c3d4e5f6b002';
    const WORDS = { en, ur };
    const MESSAGES = {
      other_quote_sent: {
        en: 'The customer already has another quote for this lead. Make a new version of that quote instead.',
        ur: 'کسٹمر کے پاس اس لیڈ کی ایک اور کوٹیشن پہلے سے موجود ہے۔ اسی کوٹیشن کا نیا ورژن بنائیں۔',
      },
      conflict: {
        en: 'Someone else changed this at the same time. Reload the page and try again.',
        ur: 'اسی وقت کسی اور نے اسے تبدیل کیا ہے۔ صفحہ دوبارہ لوڈ کریں اور پھر کوشش کریں۔',
      },
    };
    const refused = (code: string, fields?: Record<string, string>) =>
      json(409, { error: { code, message: 'x', ...(fields ? { fields } : {}) } });
    const sent = { ...draft, status: 'sent', sentAt: '2026-11-13T07:00:00.000Z' };

    it.each(['en', 'ur'] as const)(
      'sending while the customer has another quote says so (%s)',
      async (language) => {
        const words = WORDS[language].admin;
        mockApi({
          'GET /auth/me': () => json(200, user('sales')),
          [`GET /admin/quotes/${QUOTE}`]: () => json(200, draft),
          [`POST /admin/quotes/${QUOTE}/send`]: () =>
            refused('other_quote_sent', { existingId: OTHER }),
        });
        await i18n.changeLanguage(language);
        const ui = userEvent.setup();
        renderAt(`/admin/quotes/${QUOTE}`);
        await ui.click(await screen.findByRole('button', { name: words.quotes.send }));
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(MESSAGES.other_quote_sent[language]);
        expect(alert).not.toHaveTextContent(words.errors.unknown);
        // Nothing was sent: still the draft, and no link is shown.
        expect(screen.getByRole('button', { name: words.quotes.send })).toBeInTheDocument();
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
      },
    );

    it.each(['en', 'ur'] as const)(
      'creating a quote at the same moment as someone else says to reload (%s)',
      async (language) => {
        const words = WORDS[language].admin;
        mockApi({
          'GET /auth/me': () => json(200, user('sales')),
          [`GET /admin/leads/${LEAD}`]: () => json(200, leadDetail()),
          'GET /admin/leads/assignees': () => json(200, { items: [] }),
          [`POST /admin/leads/${LEAD}/quotes`]: () => refused('conflict'),
        });
        await i18n.changeLanguage(language);
        const ui = userEvent.setup();
        renderAt(`/admin/leads/${LEAD}`);
        await ui.click(await screen.findByRole('button', { name: words.quotes.create }));
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(MESSAGES.conflict[language]);
        expect(alert).not.toHaveTextContent(words.errors.unknown);
        // Still on the lead, with the button to try again.
        expect(screen.getByRole('button', { name: words.quotes.create })).toBeInTheDocument();
      },
    );

    it('a new version refused as a conflict says to reload', async () => {
      mockApi({
        'GET /auth/me': () => json(200, user('sales')),
        [`GET /admin/quotes/${QUOTE}`]: () => json(200, sent),
        [`POST /admin/quotes/${QUOTE}/new-version`]: () => refused('conflict'),
      });
      const ui = userEvent.setup();
      renderAt(`/admin/quotes/${QUOTE}`);
      await ui.click(await screen.findByRole('button', { name: 'Make a new version' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.conflict.en);
    });

    it('a second draft made at the same moment still opens the draft that won', async () => {
      const winner = { ...draft, id: OTHER, version: 2, previousId: QUOTE };
      mockApi({
        'GET /auth/me': () => json(200, user('sales')),
        [`GET /admin/quotes/${QUOTE}`]: () => json(200, sent),
        [`POST /admin/quotes/${QUOTE}/new-version`]: () =>
          refused('draft_exists', { existingId: OTHER }),
        [`GET /admin/quotes/${OTHER}`]: () => json(200, winner),
      });
      const ui = userEvent.setup();
      renderAt(`/admin/quotes/${QUOTE}`);
      await ui.click(await screen.findByRole('button', { name: 'Make a new version' }));
      expect(await screen.findByRole('heading', { name: /quote version 2/ })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('every quote and lead error code the API sends to staff has wording in both languages', () => {
      // The codes raised by the leads and quotes services and by the duplicate-key fallback.
      const codes = [
        'draft_exists',
        'open_quote_exists',
        'other_quote_sent',
        'conflict',
        'quote_not_draft',
        'quote_not_sent',
        'quote_empty',
        'quote_unsaved',
        'previous_accepted',
        'prices_unavailable',
        'lead_closed',
        'lead_changed',
        'invalid_transition',
        'validation_error',
        'not_found',
      ];
      for (const language of ['en', 'ur'] as const) {
        const errors: Record<string, string> = WORDS[language].admin.errors;
        for (const code of codes) {
          expect(errors[code], `${language}: ${code}`).toEqual(expect.any(String));
          expect(errors[code], `${language}: ${code}`).not.toBe(errors.unknown);
        }
      }
      expect(en.admin.errors.other_quote_sent).toBe(MESSAGES.other_quote_sent.en);
      expect(ur.admin.errors.other_quote_sent).toBe(MESSAGES.other_quote_sent.ur);
      expect(en.admin.errors.conflict).toBe(MESSAGES.conflict.en);
      expect(ur.admin.errors.conflict).toBe(MESSAGES.conflict.ur);
    });
  });
});

describe('staff dashboard (FEAT-01)', () => {
  const QUOTE = '64b7f0c2a1b2c3d4e5f6c001';
  const PACK = '64b7f0c2a1b2c3d4e5f6d001';
  const LATEST = '64b7f0c2a1b2c3d4e5f6d002';

  const full = (overrides: Partial<DashboardSummary> = {}): DashboardSummary => ({
    generatedAt: '2026-11-17T10:00:00.000Z',
    leads: { newCount: 4 },
    quotes: {
      windowHours: 48,
      expiringCount: 12,
      expiring: [
        {
          quoteId: QUOTE,
          leadId: '64b7f0c2a1b2c3d4e5f6e001',
          leadReference: 'MSF-2026-000123',
          version: 2,
          expiresAt: '2026-11-18T18:59:59.999Z',
        },
      ],
    },
    rates: {
      windowDays: 14,
      expiringCount: 1,
      expiring: [
        {
          packageId: PACK,
          packName: 'Shawal Pack',
          supplierName: 'Waqar-e-Madina',
          version: 3,
          nightTo: '2026-11-25',
        },
      ],
      lastPublished: {
        packageId: LATEST,
        packName: 'Ramadan Pack 01',
        supplierName: 'Waqar-e-Madina',
        version: 5,
        status: 'published',
        publishedAt: '2026-11-16T07:30:00.000Z',
      },
    },
    ...overrides,
  });

  const card = (name: RegExp | string) =>
    screen.findByRole('region', { name }).then((region) => within(region));

  it('shows the four figures from the API, each linking to its page', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': () => json(200, user('admin')),
      'GET /admin/dashboard': () => json(200, full()),
    });
    renderAt('/admin');

    const leads = await card('New leads');
    expect(leads.getByText('4')).toBeInTheDocument();
    expect(leads.getByRole('link', { name: 'Open new inquiries' })).toHaveAttribute(
      'href',
      '/admin/leads?status=new',
    );
    // Browser tests find the menu with getByRole('link', { name: 'Leads' }), which also
    // matches any link whose name merely contains "leads": keep it the only one.
    expect(screen.getAllByRole('link', { name: /leads/i })).toHaveLength(1);

    const quotes = await card('Quotes expiring within 48 hours');
    expect(quotes.getByText('12')).toBeInTheDocument();
    expect(quotes.getByRole('link', { name: 'MSF-2026-000123 · quote version 2' })).toHaveAttribute(
      'href',
      `/admin/quotes/${QUOTE}`,
    );
    // Pakistan time: 18:59 UTC is 23:59 in Karachi.
    expect(quotes.getByText(/Link stops working 18 Nov 2026, 23:59/)).toBeInTheDocument();
    expect(quotes.getByText('and 11 more')).toBeInTheDocument();
    expect(quotes.getByRole('link', { name: 'Open sent quotes' })).toHaveAttribute(
      'href',
      '/admin/leads?status=quote_sent',
    );

    const packs = await card('Rate packs ending within 14 days');
    expect(packs.getByText('1')).toBeInTheDocument();
    expect(packs.getByRole('link', { name: 'Shawal Pack · Waqar-e-Madina' })).toHaveAttribute(
      'href',
      `/admin/rate-sheets/${PACK}`,
    );
    expect(packs.getByText('Last night 25 Nov 2026 · version 3')).toBeInTheDocument();
    expect(packs.getByRole('link', { name: 'Open rate sheets list' })).toHaveAttribute(
      'href',
      '/admin/rate-sheets',
    );

    const published = await card('Last published rate version');
    expect(
      published.getByRole('link', { name: 'Ramadan Pack 01 · Waqar-e-Madina' }),
    ).toHaveAttribute('href', `/admin/rate-sheets/${LATEST}`);
    expect(published.getByText(/Version 5 · published 16 Nov 2026, 12:30/)).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/dashboard', expect.anything());
  });

  it('shows a loading message until the figures arrive', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => (answer = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith('/auth/me')) return json(200, user('sales'));
        if (path.endsWith('/admin/dashboard')) return pending;
        return unauthenticated();
      }),
    );
    renderAt('/admin');
    // The shell is signed in (its heading is up) while the figures are still on the way.
    await screen.findByRole('heading', { name: 'Welcome, Test sales' });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    answer(json(200, full({ rates: null })));
    expect(await screen.findByRole('region', { name: 'New leads' })).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('says so plainly when there is nothing to show', async () => {
    mockApi({
      'GET /auth/me': () => json(200, user('admin')),
      'GET /admin/dashboard': () =>
        json(200, {
          generatedAt: '2026-11-17T10:00:00.000Z',
          leads: { newCount: 0 },
          quotes: { windowHours: 48, expiringCount: 0, expiring: [] },
          rates: { windowDays: 14, expiringCount: 0, expiring: [], lastPublished: null },
        } satisfies DashboardSummary),
    });
    renderAt('/admin');
    expect(await screen.findByText('No sent quote expires in the next 48 hours.')).toBeVisible();
    expect(screen.getByText('No published rate pack ends in the next 14 days.')).toBeVisible();
    expect(screen.getByText('No rate sheet has been published yet.')).toBeVisible();
    expect((await card('New leads')).getByText('0')).toBeInTheDocument();
  });

  it('shows only the cards a role may see', async () => {
    // Sales and finance: no rate packs. Ops: no quotes (decision 133).
    mockApi({
      'GET /auth/me': () => json(200, user('sales')),
      'GET /admin/dashboard': () => json(200, full({ rates: null })),
    });
    const { unmount } = renderAt('/admin');
    expect(await screen.findByRole('region', { name: /Quotes expiring/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Rate packs/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Last published/ })).not.toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();

    mockApi({
      'GET /auth/me': () => json(200, user('ops')),
      'GET /admin/dashboard': () => json(200, full({ quotes: null })),
    });
    renderAt('/admin');
    expect(await screen.findByRole('region', { name: /Rate packs/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Quotes expiring/ })).not.toBeInTheDocument();
  });

  it('reports a failed load and recovers with Try again', async () => {
    let fail = true;
    mockApi({
      'GET /auth/me': () => json(200, user('admin')),
      'GET /admin/dashboard': () =>
        fail
          ? json(500, { error: { code: 'internal_error', message: 'Something went wrong' } })
          : json(200, full()),
    });
    renderAt('/admin');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The dashboard could not be loaded.',
    );
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'New leads' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders in Urdu, right to left', async () => {
    await i18n.changeLanguage('ur');
    mockApi({
      'GET /auth/me': () => json(200, user('admin')),
      'GET /admin/dashboard': () => json(200, full()),
    });
    renderAt('/admin');
    expect(
      await screen.findByRole('region', { name: ur.admin.dashboard.newLeads.title }),
    ).toBeVisible();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('opens the lead list already filtered from the dashboard link', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': () => json(200, user('sales')),
      'GET /admin/leads?page=1&limit=25&status=new': () =>
        json(200, { items: [], page: 1, limit: 25, total: 0 }),
    });
    renderAt('/admin/leads?status=new');
    expect(await screen.findByLabelText('Status')).toHaveValue('new');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/leads?page=1&limit=25&status=new',
      expect.anything(),
    );
  });

  it('ignores an unknown status in the address', async () => {
    mockApi({
      'GET /auth/me': () => json(200, user('sales')),
      'GET /admin/leads?page=1&limit=25': () =>
        json(200, { items: [], page: 1, limit: 25, total: 0 }),
    });
    renderAt('/admin/leads?status=booked');
    expect(await screen.findByLabelText('Status')).toHaveValue('');
  });
});
