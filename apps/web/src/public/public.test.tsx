import type { CalculationResult, PublicConfig, PublicHotel } from '@marafiq/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import i18n from '../i18n';
import ur from '../locales/ur.json';
import { addDays, todayInPakistan } from './format';
import { clearPublicCache } from './usePublic';

const ARRIVAL = addDays(todayInPakistan(), 30);
const QILA = '64b7f0c2a1b2c3d4e5f60001';
const SALMIYA = '64b7f0c2a1b2c3d4e5f60002';
const PACK = '64b7f0c2a1b2c3d4e5f600a1';
const SUPPLIER = '64b7f0c2a1b2c3d4e5f600b1';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const config: PublicConfig = {
  languages: ['en', 'ur'],
  fx: { rate: '75.00', effectiveAt: new Date('2026-11-01T00:00:00Z') },
  markupApplied: false,
  showSupplierRates: true,
  responseTimeText: 'We usually reply within 24 hours.',
  departureCities: ['Islamabad', 'Lahore'],
};

const from = {
  supplierName: 'Waqar-e-Madina Group (WMT)',
  packName: 'Shawal',
  issueDate: '2026-10-27',
};
const hotels: PublicHotel[] = [
  {
    id: QILA,
    city: 'makkah',
    name: 'Qila Ajiyad',
    distanceMeters: 1100,
    distanceNote: '',
    transport: 'shuttle',
    ratesFrom: '2027-02-06',
    ratesTo: '2027-04-06',
    fromPerPerson: { ...from, minorSAR: 1900, minorPKR: 142_500 },
    fromPerRoom: null,
    onRequestOnly: false,
  },
  {
    id: SALMIYA,
    city: 'madinah',
    name: 'Waqar Salmiya/Jood Marjan',
    distanceMeters: null,
    distanceNote: 'Near Bab Majidi',
    transport: 'walking',
    ratesFrom: '2027-02-06',
    ratesTo: '2027-04-06',
    fromPerPerson: { ...from, minorSAR: 3000, minorPKR: 225_000 },
    fromPerRoom: null,
    onRequestOnly: false,
  },
];

const source = {
  packageId: PACK,
  version: 1,
  packName: 'Ramadan Pack 01',
  supplierId: SUPPLIER,
  supplierName: 'Waqar-e-Madina Group (WMT)',
  issueDate: '2026-10-27',
  nightFrom: '2027-02-06',
  nightTo: '2027-02-26',
};

/** T1 as the API returns it (docs/03 section 7). */
function t1Result(): CalculationResult {
  return {
    inputs: {
      departureCity: 'Islamabad',
      arrivalDate: ARRIVAL,
      flexibilityDays: 0,
      nightsMakkah: 3,
      nightsMadinah: 2,
      order: 'makkah_first',
      travelers: { adults: 4, children: 0, infants: 0 },
      rooms: [{ occupancy: 'quad', persons: 4 }],
      hotels: { makkah: QILA, madinah: SALMIYA },
      visa: 'direct',
      flight: 'estimate',
      extras: [],
    },
    rateVersionSnapshot: [
      { packageId: PACK, version: 1, supplierId: SUPPLIER, issueDate: '2026-10-27' },
    ],
    fx: { rate: '75.00', effectiveAt: new Date('2026-11-01T00:00:00Z') },
    markupPercent: 0,
    lineItems: [
      {
        kind: 'hotel',
        city: 'makkah',
        hotelId: QILA,
        hotelName: 'Qila Ajiyad',
        firstNight: ARRIVAL,
        lastNight: addDays(ARRIVAL, 2),
        nights: 3,
        occupancy: 'quad',
        persons: 4,
        rooms: 1,
        basis: 'per_person',
        unitMinorSAR: 5000,
        amountMinorSAR: 60_000,
        amountMinorPKR: 4_500_000,
        source,
        label: 'Qila Ajiyad, 3 nights × 4 persons × SAR 50',
      },
      {
        kind: 'hotel',
        city: 'madinah',
        hotelId: SALMIYA,
        hotelName: 'Waqar Salmiya/Jood Marjan',
        firstNight: addDays(ARRIVAL, 3),
        lastNight: addDays(ARRIVAL, 4),
        nights: 2,
        occupancy: 'quad',
        persons: 4,
        rooms: 1,
        basis: 'per_person',
        unitMinorSAR: 5400,
        amountMinorSAR: 43_200,
        amountMinorPKR: 3_240_000,
        source,
        label: 'Waqar Salmiya/Jood Marjan, 2 nights × 4 persons × SAR 54',
      },
      {
        kind: 'visa',
        visa: 'direct',
        persons: 4,
        unitMinorSAR: 55_000,
        amountMinorSAR: 220_000,
        amountMinorPKR: 16_500_000,
        source,
        label: 'Umrah visa (direct flight), 4 persons × SAR 550',
      },
    ],
    missing: [{ kind: 'flight', code: 'flight_no_estimate', message: 'Flight: request a quote' }],
    assumptions: [
      { code: 'visa_per_person_bus', message: 'Visa rates are per person…' },
      { code: 'rates_can_change', message: 'Rates can change without notice.' },
    ],
    exclusions: [
      { code: 'flights_missing', message: 'Flights (not priced in this estimate)' },
      { code: 'meals', message: 'Meals' },
    ],
    totals: {
      groupMinorSAR: 323_200,
      groupMinorPKR: 24_240_000,
      perPersonMinorSAR: 80_800,
      perPersonMinorPKR: 6_060_000,
      payingPersons: 4,
      isPartial: true,
      range: null,
    },
    calculatedAt: new Date('2026-11-13T10:00:00Z'),
    expiresAt: new Date('2026-11-16T10:00:00Z'),
    hash: 'a'.repeat(64),
    engineVersion: '1.0.0',
  };
}

type Handler = (init?: RequestInit) => Response;

function mockApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).replace('/api/v1', '')}`;
    const handler = routes[key];
    return handler ? handler(init) : json(404, { error: { code: 'not_found', message: 'x' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const publicRoutes = (extra: Record<string, Handler> = {}) => ({
  'GET /public/config': () => json(200, config),
  'GET /public/hotels': () => json(200, { items: hotels }),
  ...extra,
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

async function fillT1(ui: ReturnType<typeof userEvent.setup>) {
  await ui.selectOptions(await screen.findByLabelText('Departure city'), 'Islamabad');
  const date = screen.getByLabelText('Arrival date in Saudi Arabia');
  await ui.clear(date);
  await ui.type(date, ARRIVAL);
  const makkah = screen.getByLabelText('Nights in Makkah');
  await ui.clear(makkah);
  await ui.type(makkah, '3');
  const madinah = screen.getByLabelText('Nights in Madinah');
  await ui.clear(madinah);
  await ui.type(madinah, '2');
  const adults = screen.getByLabelText('Adults');
  await ui.clear(adults);
  await ui.type(adults, '4');
  await ui.selectOptions(screen.getByLabelText('Room type'), 'quad');
  const persons = screen.getByLabelText('People in this room');
  await ui.clear(persons);
  await ui.type(persons, '4');
  await screen.findByRole('option', { name: /Qila Ajiyad/ });
  await ui.selectOptions(screen.getByLabelText('Hotel in Makkah'), QILA);
  await ui.selectOptions(screen.getByLabelText('Hotel in Madinah'), SALMIYA);
}

beforeEach(async () => {
  clearPublicCache();
  window.localStorage.clear();
  window.sessionStorage.clear();
  await i18n.changeLanguage('en');
});

afterEach(() => vi.unstubAllGlobals());

describe('Umrah calculator', () => {
  it('sends the trip and shows T1: itemised, partial, PKR with SAR beside', async () => {
    let sent: unknown;
    mockApi(
      publicRoutes({
        'POST /public/calculate': (init) => {
          sent = JSON.parse(String(init?.body));
          return json(200, t1Result());
        },
      }),
    );
    const ui = userEvent.setup();
    renderAt('/umrah');
    await fillT1(ui);
    await ui.click(screen.getByRole('button', { name: 'See my estimate' }));

    const heading = await screen.findByRole('heading', { name: 'Your estimate' });
    expect(heading).toHaveFocus();
    expect(sent).toMatchObject({
      departureCity: 'Islamabad',
      arrivalDate: ARRIVAL,
      nightsMakkah: 3,
      nightsMadinah: 2,
      travelers: { adults: 4, children: 0, infants: 0 },
      rooms: [{ occupancy: 'quad', persons: 4 }],
      hotels: { makkah: QILA, madinah: SALMIYA },
      visa: 'direct',
      flight: 'estimate',
    });

    const result = heading.closest('section') as HTMLElement;
    expect(within(result).getByText('Estimate for priced items only')).toBeInTheDocument();
    expect(within(result).getByText('Total for priced items')).toBeInTheDocument();
    expect(within(result).getByText('PKR 242,400')).toBeInTheDocument();
    expect(within(result).getByText('SAR 3,232')).toBeInTheDocument();
    expect(within(result).getByText('PKR 60,600')).toBeInTheDocument();
    expect(within(result).getByText('SAR 808')).toBeInTheDocument();
    expect(within(result).getByText('3 nights', { exact: false })).toBeInTheDocument();
    expect(
      within(result).getAllByText(
        /Waqar-e-Madina Group \(WMT\) · Ramadan Pack 01 · sheet dated 27 Oct 2026/,
      ),
    ).toHaveLength(3);
    // The missing flight is "Request a quote" and not part of the total.
    const missing = within(result).getByRole('heading', { name: 'Not priced yet' })
      .nextElementSibling as HTMLElement;
    expect(missing).toHaveTextContent('Flight');
    expect(missing).toHaveTextContent('Request a quote');
    expect(within(result).getAllByText('Rates can change without notice.').length).toBeGreaterThan(
      0,
    );
    expect(within(result).getByText(/Valid until/)).toBeInTheDocument();
  });

  it('puts SAR first when the currency switch says SAR', async () => {
    mockApi(publicRoutes({ 'POST /public/calculate': () => json(200, t1Result()) }));
    const ui = userEvent.setup();
    renderAt('/umrah');
    await fillT1(ui);
    await ui.click(screen.getByRole('button', { name: 'SAR' }));
    await ui.click(screen.getByRole('button', { name: 'See my estimate' }));
    const total = (await screen.findByText('Total for priced items')).parentElement as HTMLElement;
    const amounts = within(total)
      .getAllByText(/^(SAR|PKR) /)
      .map((el) => el.textContent);
    expect(amounts).toEqual(['SAR 3,232', 'PKR 242,400']);
    expect(screen.getByRole('button', { name: 'SAR' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the result in Urdu, right to left', async () => {
    mockApi(publicRoutes({ 'POST /public/calculate': () => json(200, t1Result()) }));
    const ui = userEvent.setup();
    renderAt('/umrah');
    await fillT1(ui);
    await ui.click(screen.getByRole('button', { name: 'اردو' }));
    await ui.click(screen.getByRole('button', { name: ur.calc.calculate }));

    expect(await screen.findByRole('heading', { name: ur.calc.resultTitle })).toBeInTheDocument();
    expect(screen.getByText(ur.calc.partialLabel)).toBeInTheDocument();
    const result = screen
      .getByRole('heading', { name: ur.calc.resultTitle })
      .closest('section') as HTMLElement;
    expect(within(result).getByText(ur.calc.notes.flight_no_estimate)).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('lists problems before sending, with links to the fields', async () => {
    const fetchMock = mockApi(publicRoutes());
    const ui = userEvent.setup();
    renderAt('/umrah');
    const adults = await screen.findByLabelText('Adults');
    await ui.clear(adults);
    await ui.type(adults, '3');
    await ui.click(screen.getByRole('button', { name: 'See my estimate' }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveFocus();
    expect(within(summary).getByRole('link', { name: 'Choose your arrival date' })).toHaveAttribute(
      'href',
      '#f-arrivalDate',
    );
    expect(
      within(summary).getByRole('link', { name: /Every adult and child needs a place/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Arrival date in Saudi Arabia')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('shows field messages the server sends back', async () => {
    mockApi(
      publicRoutes({
        'POST /public/calculate': () =>
          json(400, {
            error: {
              code: 'validation_error',
              message: 'Please check the highlighted fields',
              fields: { arrivalDate: 'Choose today or a later date' },
            },
          }),
      }),
    );
    const ui = userEvent.setup();
    renderAt('/umrah');
    await fillT1(ui);
    await ui.click(screen.getByRole('button', { name: 'See my estimate' }));
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('Choose today or a later date');
  });

  it('asks for a quote instead of guessing when prices are unavailable', async () => {
    mockApi(
      publicRoutes({
        'POST /public/calculate': () =>
          json(503, { error: { code: 'prices_unavailable', message: 'x' } }),
      }),
    );
    const ui = userEvent.setup();
    renderAt('/umrah');
    await fillT1(ui);
    await ui.click(screen.getByRole('button', { name: 'See my estimate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Prices are not available right now',
    );
    expect(screen.queryByRole('heading', { name: 'Your estimate' })).not.toBeInTheDocument();
  });

  it('"Request a quote" carries a trip summary to the Contact page', async () => {
    mockApi(publicRoutes({ 'POST /public/calculate': () => json(200, t1Result()) }));
    const ui = userEvent.setup();
    renderAt('/umrah');
    await fillT1(ui);
    await ui.click(screen.getByRole('button', { name: 'See my estimate' }));
    await screen.findByRole('heading', { name: 'Your estimate' });
    await ui.click(screen.getByRole('button', { name: 'Request a quote' }));

    expect(
      await screen.findByRole('heading', { name: 'Contact us', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('About: Umrah')).toBeInTheDocument();
    expect(
      screen.getByText(/Qila Ajiyad, 3 nights × 4 persons × SAR 50: SAR 600 \/ PKR 45000/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Request a quote: Flight: request a quote/)).toBeInTheDocument();
  });

  it('keeps rooms the right size when the room type changes', async () => {
    mockApi(publicRoutes());
    const ui = userEvent.setup();
    renderAt('/umrah');
    const type = await screen.findByLabelText('Room type');
    await ui.selectOptions(type, 'quad');
    const persons = screen.getByLabelText('People in this room');
    await ui.clear(persons);
    await ui.type(persons, '4');
    await ui.selectOptions(type, 'double');
    expect(screen.getByLabelText('People in this room')).toHaveValue(2);
    await ui.click(screen.getByRole('button', { name: 'Add a room' }));
    expect(screen.getAllByLabelText('Room type')).toHaveLength(2);
    await ui.click(screen.getByRole('button', { name: 'Remove room 2' }));
    expect(screen.getAllByLabelText('Room type')).toHaveLength(1);
  });
});

describe('public pages', () => {
  it('home links to the calculator; the phone menu opens and closes', async () => {
    mockApi(publicRoutes());
    const ui = userEvent.setup();
    renderAt('/');
    expect(screen.getByRole('link', { name: 'Start the Umrah calculator' })).toHaveAttribute(
      'href',
      '/umrah',
    );
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await ui.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    await ui.click(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Hotels',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Hotels', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('hotels list distance, transport and the lowest published price with its source', async () => {
    mockApi(publicRoutes());
    renderAt('/hotels');
    const qila = (await screen.findByRole('heading', { name: 'Qila Ajiyad' })).closest(
      'li',
    ) as HTMLElement;
    expect(qila).toHaveTextContent('about 1,100 m from the Haram · shuttle');
    expect(qila).toHaveTextContent('From PKR 1,425 per person per night');
    expect(qila).toHaveTextContent('(SAR 19)');
    expect(qila).toHaveTextContent('Waqar-e-Madina Group (WMT) · Shawal · sheet dated 27 Oct 2026');
    const salmiya = screen
      .getByRole('heading', { name: 'Waqar Salmiya/Jood Marjan' })
      .closest('li') as HTMLElement;
    expect(salmiya).toHaveTextContent('Near Bab Majidi · walking');
  });

  it('policies are marked for legal review and missing contact details are marked, not invented', async () => {
    mockApi(publicRoutes());
    renderAt('/policies/privacy');
    expect(screen.getByRole('heading', { name: 'Privacy policy', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('[LEGAL REVIEW NEEDED]')).toBeInTheDocument();
  });

  it('contact shows a marker for each detail the client has not given yet', async () => {
    mockApi(publicRoutes());
    renderAt('/contact');
    expect(screen.getAllByText('[CLIENT TO PROVIDE]')).toHaveLength(5);
    expect(await screen.findByText('We usually reply within 24 hours.')).toBeInTheDocument();
  });

  it('the visa page says decisions rest with the issuing authority and asks for no documents', () => {
    mockApi(publicRoutes());
    renderAt('/visa');
    expect(screen.getByText(/Visa decisions rest with the issuing authority/)).toBeInTheDocument();
    expect(screen.getByText(/do not send passport, CNIC or card numbers/)).toBeInTheDocument();
  });

  it('footer shows the company placeholder and the approved partner wording (docs/05 #1, #2)', () => {
    mockApi(publicRoutes());
    renderAt('/');
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent(
      '[COMPANY NAME] — quote and planning service; services fulfilled by licensed partners',
    );
    expect(footer).not.toHaveTextContent('[URDU TRANSLATION NEEDED]');
    // No raw i18n key may leak into the page (an empty English value once did).
    expect(footer).not.toHaveTextContent(/site\.legal/);
  });

  it('in Urdu the footer keeps the approved English wording and marks the missing translation', async () => {
    mockApi(publicRoutes());
    await i18n.changeLanguage('ur');
    renderAt('/');
    const footer = screen.getByRole('contentinfo');
    const wording = within(footer).getByText(
      '[COMPANY NAME] — quote and planning service; services fulfilled by licensed partners',
    );
    expect(wording).toHaveAttribute('lang', 'en');
    expect(within(footer).getByText('[URDU TRANSLATION NEEDED]')).toBeInTheDocument();
    expect(footer).not.toHaveTextContent(/site\.legal/);
  });

  it('hotels hold their place while loading, then show the list (no layout jump)', async () => {
    // The hotel list answers only when the test releases it.
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => (release = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/public/hotels') ? pending : json(200, config),
      ),
    );
    const { container } = renderAt('/hotels');
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    const skeleton = container.querySelector('[aria-busy="true"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.querySelectorAll('li').length).toBeGreaterThanOrEqual(4);
    release(json(200, { items: hotels }));
    expect(await screen.findByRole('heading', { name: 'Qila Ajiyad' })).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('in Urdu a hotel option keeps the English name isolated and the hint repeats it in full', async () => {
    mockApi(publicRoutes());
    await i18n.changeLanguage('ur');
    const ui = userEvent.setup();
    renderAt('/umrah');
    const label = ur.calc.hotelIn.replace('{{city}}', ur.calc.city.makkah);
    const option = await screen.findByRole('option', { name: /Qila Ajiyad/ });
    // U+2066 LEFT-TO-RIGHT ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE around the name.
    expect(option.textContent?.startsWith('⁦Qila Ajiyad⁩')).toBe(true);
    await ui.selectOptions(screen.getByLabelText(label), QILA);
    const hint = screen.getByText('Qila Ajiyad', { selector: 'bdi' });
    expect(hint).toHaveAttribute('lang', 'en');
  });

  it('robots.txt lets search engines index public pages but not /admin or the API', async () => {
    const { default: robots } = await import('../../public/robots.txt?raw');
    const rules = robots
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(rules).toEqual(['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /api/']);
    for (const page of ['/', '/umrah', '/hotels', '/flights', '/visa', '/faq', '/contact']) {
      const blocked = rules
        .filter((r) => r.startsWith('Disallow: '))
        .some((r) => page.startsWith(r.slice('Disallow: '.length)));
      expect(blocked).toBe(false);
    }
  });

  it('customer text never says "booked", "confirmed", "best price", "guaranteed" or "halal certified"', () => {
    const bundle = i18n.getResourceBundle('en', 'translation') as Record<string, unknown>;
    const { admin: _staffOnly, ...customer } = bundle;
    const text = JSON.stringify(customer).toLowerCase();
    for (const banned of [
      /\bbooked\b/,
      /\bconfirmed\b/,
      /best price/,
      /\bguaranteed\b/,
      /halal[ -]certified/,
    ]) {
      expect(text).not.toMatch(banned);
    }
    expect(text).toContain('we cannot guarantee a visa');
  });
});
