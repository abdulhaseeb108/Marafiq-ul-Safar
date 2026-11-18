/**
 * Business contact details shown on the Contact page. The client has not
 * supplied them yet, so each one is null and the page shows a visible
 * "[CLIENT TO PROVIDE]" marker instead of an invented number or address
 * (CLAUDE.md: do not invent data). Fill these in before launch.
 */
export const CONTACT = {
  phone: null as string | null,
  whatsapp: null as string | null,
  email: null as string | null,
  address: null as string | null,
  hours: null as string | null,
};

/** The estimate handed from the calculator to the quote request form (this tab only). */
export const PENDING_TRIP_KEY = 'msf.pendingTrip';
