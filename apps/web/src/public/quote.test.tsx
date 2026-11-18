import {
  CONSENT_TEXT_VERSION,
  CUSTOMER_QUOTE_STATUS_WORDING,
  type CalculationResult,
  type PublicQuoteView,
} from '@marafiq/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import i18n from '../i18n';
import { PENDING_TRIP_KEY } from './site';
import { clearPublicCache } from './usePublic';

const TOKEN = 'A'.repeat(21) + 'b_-'.repeat(7) + 'z';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

function quote(overrides: Partial<PublicQuoteView> = {}): PublicQuoteView {
  return {
    reference: 'MSF-2026-000001',
    version: 1,
    status: 'sent',
    travelerName: 'Aisha Khan',
    lineItems: [
      {
        description: 'Qila Ajiyad (Makkah), quad sharing, 3 nights',
        supplier: 'Waqar-e-Madina Group (WMT)',
        quantity: 12,
        unitAmountMinor: 5_000,
        currency: 'SAR',
        notes: 'Ramadan Pack 01',
        amountMinor: 60_000,
        amountMinorSAR: 60_000,
        amountMinorPKR: 4_500_000,
      },
      {
        description: 'Flights ISB-JED return',
        supplier: 'Airline via agent',
        quantity: 4,
        unitAmountMinor: 18_000_000,
        currency: 'PKR',
        notes: '',
        amountMinor: 72_000_000,
        amountMinorSAR: 960_000,
        amountMinorPKR: 72_000_000,
      },
    ],
    exclusions: ['Meals'],
    terms: 'Rates can change without notice until each supplier confirms.',
    fx: { rate: '75.00', effectiveAt: '2026-11-01T00:00:00.000Z' },
    totals: { totalMinorPKR: 76_500_000, totalMinorSAR: 1_020_000 },
    sentAt: '2026-11-13T10:00:00.000Z',
    expiresAt: '2026-11-16T18:59:59.999Z',
    acceptedAt: null,
    canAccept: true,
    viaOlderLink: false,
    hasNewerVersion: false,
    ...overrides,
  };
}

const configRoute = () =>
  json(200, {
    languages: ['en', 'ur'],
    fx: null,
    markupApplied: false,
    showSupplierRates: true,
    responseTimeText: 'We usually reply within 24 hours.',
    departureCities: [],
  });

beforeEach(async () => {
  clearPublicCache();
  window.localStorage.clear();
  window.sessionStorage.clear();
  await i18n.changeLanguage('en');
});
afterEach(() => vi.unstubAllGlobals());

describe('quote request form', () => {
  const trip = {
    inputs: {
      arrivalDate: '2027-02-08',
      nightsMakkah: 3,
      nightsMadinah: 2,
      travelers: { adults: 4, children: 0, infants: 0 },
    },
    totals: { groupMinorSAR: 323_200, groupMinorPKR: 24_240_000, isPartial: false },
    missing: [],
  } as unknown as CalculationResult;

  it('sends contact details, consent version and the trip; shows the reference', async () => {
    window.sessionStorage.setItem(PENDING_TRIP_KEY, JSON.stringify(trip));
    let sent: Record<string, unknown> = {};
    mockApi({
      'GET /public/config': configRoute,
      'POST /public/inquiries': (init) => {
        sent = JSON.parse(String(init?.body));
        return json(201, {
          reference: 'MSF-2026-000042',
          duplicate: false,
          responseTimeText: 'We usually reply within 24 hours.',
        });
      },
    });
    const ui = userEvent.setup();
    renderAt('/request-quote?topic=umrah');
    await ui.type(screen.getByLabelText('Your name'), 'Aisha Khan');
    await ui.type(screen.getByLabelText('Mobile number (WhatsApp preferred)'), '0300 1234567');
    await ui.click(screen.getByRole('radio', { name: 'اردو' }));
    await ui.click(screen.getByRole('checkbox'));
    await ui.click(screen.getByRole('button', { name: 'Send my request' }));

    const heading = await screen.findByRole('heading', { name: 'Thank you, we have your request' });
    expect(heading).toHaveFocus();
    expect(screen.getByText('MSF-2026-000042')).toBeInTheDocument();
    expect(screen.getByText('We usually reply within 24 hours.')).toBeInTheDocument();
    expect(sent).toEqual({
      source: 'umrah',
      traveler: { name: 'Aisha Khan', phone: '0300 1234567', email: '', language: 'ur' },
      notes: '',
      consent: { accepted: true, textVersion: CONSENT_TEXT_VERSION },
      inputs: trip.inputs,
    });
    expect(window.sessionStorage.getItem(PENDING_TRIP_KEY)).toBeNull();
  });

  it('keeps the spam honeypot away from people and assistive technology', async () => {
    mockApi({ 'GET /public/config': configRoute });
    const { container } = renderAt('/request-quote?topic=visa');
    await screen.findByLabelText('Your name');
    const honeypot = container.querySelector<HTMLInputElement>('input[name="website"]');
    expect(honeypot).not.toBeNull();
    expect(honeypot?.tabIndex).toBe(-1);
    expect(honeypot?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: /website/i })).toBeNull();
  });

  it('checks the phone and consent before sending', async () => {
    const fetchMock = mockApi({ 'GET /public/config': configRoute });
    const ui = userEvent.setup();
    renderAt('/request-quote?topic=visa');
    await ui.type(screen.getByLabelText('Your name'), 'Aisha');
    await ui.type(screen.getByLabelText('Mobile number (WhatsApp preferred)'), '042 1234567');
    await ui.click(screen.getByRole('button', { name: 'Send my request' }));
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveFocus();
    expect(within(summary).getByRole('link', { name: /Pakistani mobile number/ })).toHaveAttribute(
      'href',
      '#f-traveler-phone',
    );
    expect(
      within(summary).getByRole('link', { name: 'Please agree so we can contact you' }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('tells the customer when the same request is already with us', async () => {
    mockApi({
      'GET /public/config': configRoute,
      'POST /public/inquiries': () =>
        json(201, { reference: 'MSF-2026-000042', duplicate: true, responseTimeText: '' }),
    });
    const ui = userEvent.setup();
    renderAt('/request-quote?topic=hotels');
    await ui.type(screen.getByLabelText('Your name'), 'Aisha');
    await ui.type(screen.getByLabelText('Mobile number (WhatsApp preferred)'), '03001234567');
    await ui.click(screen.getByRole('checkbox'));
    await ui.click(screen.getByRole('button', { name: 'Send my request' }));
    expect(
      await screen.findByRole('heading', { name: 'We already have this request' }),
    ).toBeInTheDocument();
  });
});

describe('customer quote page /q/:token', () => {
  for (const language of ['en', 'ur'] as const) {
    it.each(['sent', 'accepted', 'declined', 'expired', 'replaced'] as const)(
      `shows "%s" in the words from the wording map (${language})`,
      async (status) => {
        await i18n.changeLanguage(language);
        mockApi({
          [`GET /public/quotes/${TOKEN}`]: () =>
            json(
              200,
              quote({
                status,
                canAccept: status === 'sent',
                hasNewerVersion: status === 'replaced',
              }),
            ),
        });
        renderAt(`/q/${TOKEN}`);
        await screen.findByText(/MSF-2026-000001/);
        expect(screen.getByRole('status')).toHaveTextContent(
          CUSTOMER_QUOTE_STATUS_WORDING[language][status],
        );
        expect(document.body.textContent?.toLowerCase()).not.toMatch(/\bbooked\b/);
      },
    );
  }

  it('shows lines in both currencies, totals, expiry and the rates notice', async () => {
    mockApi({ [`GET /public/quotes/${TOKEN}`]: () => json(200, quote()) });
    renderAt(`/q/${TOKEN}`);
    expect(
      await screen.findByText('Qila Ajiyad (Makkah), quad sharing, 3 nights'),
    ).toBeInTheDocument();
    expect(screen.getByText('SAR 600')).toBeInTheDocument();
    expect(screen.getByText('PKR 45,000')).toBeInTheDocument();
    expect(screen.getByText('PKR 765,000')).toBeInTheDocument();
    expect(screen.getByText('SAR 10,200')).toBeInTheDocument();
    expect(screen.getAllByText('Rates can change without notice.').length).toBeGreaterThan(0);
    expect(screen.getByText(/Valid until/)).toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );
  });

  it('accepting asks once more, then shows "Request accepted"', async () => {
    const fetchMock = mockApi({
      [`GET /public/quotes/${TOKEN}`]: () => json(200, quote()),
      [`POST /public/quotes/${TOKEN}/accept`]: () =>
        json(
          200,
          quote({ status: 'accepted', canAccept: false, acceptedAt: '2026-11-13T11:00:00.000Z' }),
        ),
    });
    const ui = userEvent.setup();
    renderAt(`/q/${TOKEN}`);
    await ui.click(await screen.findByRole('button', { name: 'Accept quote' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await ui.click(screen.getByRole('button', { name: 'Yes, accept this quote' }));
    expect(await screen.findByText(CUSTOMER_QUOTE_STATUS_WORDING.en.accepted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept quote' })).not.toBeInTheDocument();
  });

  it.each([
    [
      'en',
      'Accept quote',
      'Yes, accept this quote',
      'Another quote for this trip has already been accepted, so this one cannot be accepted. Please contact us if you have a question.',
    ],
    [
      'ur',
      'کوٹیشن قبول کریں',
      'جی ہاں، یہ کوٹیشن قبول کریں',
      'اس سفر کی ایک اور کوٹیشن پہلے ہی قبول ہو چکی ہے، اس لیے یہ کوٹیشن قبول نہیں ہو سکتی۔ کوئی سوال ہو تو ہم سے رابطہ کریں۔',
    ],
  ] as const)(
    'says so when another quote for the trip was already accepted (%s)',
    async (language, acceptLabel, confirmLabel, message) => {
      mockApi({
        [`GET /public/quotes/${TOKEN}`]: () => json(200, quote()),
        [`POST /public/quotes/${TOKEN}/accept`]: () =>
          json(409, { error: { code: 'quote_other_accepted', message: 'x' } }),
      });
      await i18n.changeLanguage(language);
      const ui = userEvent.setup();
      renderAt(`/q/${TOKEN}`);
      await ui.click(await screen.findByRole('button', { name: acceptLabel }));
      await ui.click(screen.getByRole('button', { name: confirmLabel }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(message);
      // Not the general wording, which would wrongly say "expired or replaced".
      expect(alert).not.toHaveTextContent(i18n.t('quote.acceptFailed'));
    },
  );

  it('any other refused acceptance keeps the general wording', async () => {
    mockApi({
      [`GET /public/quotes/${TOKEN}`]: () => json(200, quote()),
      [`POST /public/quotes/${TOKEN}/accept`]: () =>
        json(409, { error: { code: 'quote_expired', message: 'x' } }),
    });
    const ui = userEvent.setup();
    renderAt(`/q/${TOKEN}`);
    await ui.click(await screen.findByRole('button', { name: 'Accept quote' }));
    await ui.click(screen.getByRole('button', { name: 'Yes, accept this quote' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This quote could not be accepted. It may have expired or been replaced; the page now shows its current status.',
    );
  });

  it('a replaced quote links to the new version through the same link', async () => {
    mockApi({
      [`GET /public/quotes/${TOKEN}`]: () =>
        json(200, quote({ status: 'replaced', canAccept: false, hasNewerVersion: true })),
      [`GET /public/quotes/${TOKEN}?follow=latest`]: () =>
        json(200, quote({ version: 2, viaOlderLink: true })),
      [`POST /public/quotes/${TOKEN}/accept?follow=latest`]: () =>
        json(200, quote({ version: 2, status: 'accepted', canAccept: false })),
    });
    const ui = userEvent.setup();
    renderAt(`/q/${TOKEN}`);
    expect(await screen.findByText('This quote was replaced')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept quote' })).not.toBeInTheDocument();
    await ui.click(screen.getByRole('link', { name: 'View the new version' }));
    expect(await screen.findByText(/version 2/)).toBeInTheDocument();
    expect(screen.getByText(/This is the newest version of your quote/)).toBeInTheDocument();
    await ui.click(screen.getByRole('button', { name: 'Accept quote' }));
    await ui.click(screen.getByRole('button', { name: 'Yes, accept this quote' }));
    expect(await screen.findByText(CUSTOMER_QUOTE_STATUS_WORDING.en.accepted)).toBeInTheDocument();
  });

  it('an expired quote offers a new request', async () => {
    mockApi({
      [`GET /public/quotes/${TOKEN}`]: () =>
        json(200, quote({ status: 'expired', canAccept: false })),
    });
    renderAt(`/q/${TOKEN}`);
    expect(await screen.findByText('Expired — request a new quote')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a quote' })).toHaveAttribute(
      'href',
      '/request-quote?topic=umrah',
    );
  });

  it('an unknown link says it is not valid', async () => {
    mockApi({});
    renderAt(`/q/${TOKEN}`);
    expect(
      await screen.findByRole('heading', { name: 'This link is not valid' }),
    ).toBeInTheDocument();
  });

  it('"Ask a question" sends the message', async () => {
    let body = '';
    mockApi({
      [`GET /public/quotes/${TOKEN}`]: () => json(200, quote()),
      [`POST /public/quotes/${TOKEN}/message`]: (init) => {
        body = JSON.parse(String(init?.body)).body;
        return json(201, { ok: true });
      },
    });
    const ui = userEvent.setup();
    renderAt(`/q/${TOKEN}`);
    await ui.type(await screen.findByLabelText('Your question'), 'Can we have a higher floor?');
    await ui.click(screen.getByRole('button', { name: 'Send question' }));
    expect(
      await screen.findByText('Your question was sent. Our team will reply.'),
    ).toBeInTheDocument();
    expect(body).toBe('Can we have a higher floor?');
  });
});
