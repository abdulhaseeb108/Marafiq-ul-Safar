/**
 * Calculator inputs and the calculation the pricing engine returns
 * (docs/01 section 4, docs/03 sections 5-7). Shared by API and web.
 *
 * Money is integer minor units: SAR halalas or PKR paisa.
 */
import { z } from 'zod';
import { fxSnapshot, isoDate, minor, objectId, timestamp } from './common.js';

export const SHARING_OCCUPANCIES = ['double', 'triple', 'quad', 'quint'] as const;
export const ROOM_OCCUPANCIES = [...SHARING_OCCUPANCIES, 'whole_room'] as const;
export const EXTRAS = ['ziyarah', 'guide', 'mobility', 'transfers'] as const;

/** Beds in a sharing room. A whole room is priced per room, not per bed. */
export const OCCUPANCY_BEDS = { double: 2, triple: 3, quad: 4, quint: 5 } as const;

/** Largest number of people we price as one room. */
export const WHOLE_ROOM_MAX_PERSONS = 5;
/** Visa rates on the sheets are printed for 1-49 travelers. */
export const MAX_TRAVELERS = 49;
export const MAX_NIGHTS_PER_CITY = 30;
export const MAX_ROOMS = 20;

export type SharingOccupancy = (typeof SHARING_OCCUPANCIES)[number];
export type RoomOccupancy = (typeof ROOM_OCCUPANCIES)[number];
export type Extra = (typeof EXTRAS)[number];

/** A hotel id, or let the engine pick from published rates. */
export const hotelChoiceSchema = z.union([objectId, z.enum(['cheapest', 'nearest'])]);

export const RoomInputSchema = z
  .object({
    occupancy: z.enum(ROOM_OCCUPANCIES),
    persons: z.number().int().min(1).max(WHOLE_ROOM_MAX_PERSONS),
  })
  .refine(
    (room) => room.occupancy === 'whole_room' || room.persons <= OCCUPANCY_BEDS[room.occupancy],
    { message: 'More people than beds in this room', path: ['persons'] },
  );

export const CalculateInputSchema = z
  .object({
    /** A city from GET /public/config, or any other text ("Other city"). */
    departureCity: z.string().trim().max(80).default(''),
    arrivalDate: isoDate,
    /** Informational only (docs/01 section 4). */
    flexibilityDays: z.number().int().min(0).max(14).default(0),
    nightsMakkah: z.number().int().min(0).max(MAX_NIGHTS_PER_CITY),
    nightsMadinah: z.number().int().min(0).max(MAX_NIGHTS_PER_CITY),
    order: z.enum(['makkah_first', 'madinah_first']),
    travelers: z.object({
      adults: z.number().int().min(1).max(MAX_TRAVELERS),
      children: z.number().int().min(0).max(MAX_TRAVELERS).default(0),
      infants: z.number().int().min(0).max(MAX_TRAVELERS).default(0),
    }),
    rooms: z.array(RoomInputSchema).min(1).max(MAX_ROOMS),
    hotels: z.object({
      makkah: hotelChoiceSchema.optional(),
      madinah: hotelChoiceSchema.optional(),
    }),
    visa: z.enum(['direct', 'indirect']),
    flight: z.enum(['estimate', 'self']),
    extras: z.array(z.enum(EXTRAS)).max(EXTRAS.length).default([]),
  })
  .superRefine((input, ctx) => {
    const { adults, children, infants } = input.travelers;
    if (input.nightsMakkah + input.nightsMadinah < 1) {
      ctx.addIssue({ code: 'custom', path: ['nightsMakkah'], message: 'Add at least one night' });
    }
    if (adults + children + infants > MAX_TRAVELERS) {
      ctx.addIssue({
        code: 'custom',
        path: ['travelers'],
        message: `We price groups of up to ${MAX_TRAVELERS} travelers here`,
      });
    }
    const inRooms = input.rooms.reduce((sum, room) => sum + room.persons, 0);
    if (inRooms !== adults + children) {
      ctx.addIssue({
        code: 'custom',
        path: ['rooms'],
        message: 'Every adult and child needs a place in a room (infants share a bed)',
      });
    }
    if (input.nightsMakkah > 0 && !input.hotels.makkah) {
      ctx.addIssue({ code: 'custom', path: ['hotels', 'makkah'], message: 'Choose a hotel' });
    }
    if (input.nightsMadinah > 0 && !input.hotels.madinah) {
      ctx.addIssue({ code: 'custom', path: ['hotels', 'madinah'], message: 'Choose a hotel' });
    }
    if (new Set(input.extras).size !== input.extras.length) {
      ctx.addIssue({ code: 'custom', path: ['extras'], message: 'Each extra once' });
    }
  });

export type CalculateInput = z.infer<typeof CalculateInputSchema>;
export type CalculateInputBody = z.input<typeof CalculateInputSchema>;
export type RoomInput = z.infer<typeof RoomInputSchema>;

/** A note the UI can translate by `code`; `message` is the English text. */
export const NoteSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type Note = z.infer<typeof NoteSchema>;

const city = z.enum(['makkah', 'madinah']);

/** Where a price came from; shown beside every price (CLAUDE.md rule 3). */
export const PriceSourceSchema = z.object({
  packageId: objectId,
  version: z.number().int().positive(),
  packName: z.string(),
  supplierId: objectId,
  supplierName: z.string(),
  issueDate: isoDate.nullable(),
  nightFrom: isoDate,
  nightTo: isoDate,
});
export type PriceSource = z.infer<typeof PriceSourceSchema>;

export const HotelLineSchema = z.object({
  kind: z.literal('hotel'),
  city,
  hotelId: objectId,
  hotelName: z.string(),
  /** First and last night of this group, inclusive. */
  firstNight: isoDate,
  lastNight: isoDate,
  nights: z.number().int().positive(),
  occupancy: z.enum(ROOM_OCCUPANCIES),
  persons: z.number().int().positive(),
  rooms: z.number().int().positive(),
  /** per_person: unit x persons x nights x rooms. per_room: unit x nights x rooms. */
  basis: z.enum(['per_person', 'per_room']),
  unitMinorSAR: minor,
  amountMinorSAR: minor,
  amountMinorPKR: minor,
  source: PriceSourceSchema,
  label: z.string(),
});

export const VisaLineSchema = z.object({
  kind: z.literal('visa'),
  visa: z.enum(['direct', 'indirect', 'infant']),
  persons: z.number().int().positive(),
  unitMinorSAR: minor,
  amountMinorSAR: minor,
  amountMinorPKR: minor,
  source: PriceSourceSchema,
  label: z.string(),
});

/** A staff estimate in PKR, never a fare quote (docs/03 section 8). */
export const FlightLineSchema = z.object({
  kind: z.literal('flight'),
  originCity: z.string(),
  destination: z.enum(['JED', 'MED']),
  adults: z.number().int().positive(),
  lowPerAdultMinorPKR: minor,
  highPerAdultMinorPKR: minor,
  lowMinorPKR: minor,
  highMinorPKR: minor,
  estimateId: objectId,
  validTo: isoDate,
  source: z.string(),
  label: z.string(),
});

export const LineItemSchema = z.discriminatedUnion('kind', [
  HotelLineSchema,
  VisaLineSchema,
  FlightLineSchema,
]);
export type HotelLine = z.infer<typeof HotelLineSchema>;
export type VisaLine = z.infer<typeof VisaLineSchema>;
export type FlightLine = z.infer<typeof FlightLineSchema>;
export type LineItem = z.infer<typeof LineItemSchema>;

export const MissingItemSchema = NoteSchema.extend({
  kind: z.enum(['hotel', 'visa', 'flight', 'extra']),
});
export type MissingItem = z.infer<typeof MissingItemSchema>;

export const CalculationTotalsSchema = z.object({
  /** Priced SAR items (hotel and visa), after markup. Flights are not included. */
  groupMinorSAR: minor,
  /** Sum of the rounded PKR lines above. */
  groupMinorPKR: minor,
  perPersonMinorSAR: minor,
  perPersonMinorPKR: minor,
  /** Adults + children: the travelers who pay. */
  payingPersons: z.number().int().positive(),
  /** True when anything is "Request a quote" or a flight range is included. */
  isPartial: z.boolean(),
  /** Present when a flight estimate is included: totals become a range. */
  range: z
    .object({
      groupLowMinorPKR: minor,
      groupHighMinorPKR: minor,
      perPersonLowMinorPKR: minor,
      perPersonHighMinorPKR: minor,
    })
    .nullable(),
});
export type CalculationTotals = z.infer<typeof CalculationTotalsSchema>;

export const RateVersionSchema = z.object({
  packageId: objectId,
  version: z.number().int().positive(),
  supplierId: objectId,
  issueDate: isoDate.nullable(),
});

/** What POST /public/calculate returns. Saved as-is when stored (a snapshot). */
export const CalculationResultSchema = z.object({
  inputs: CalculateInputSchema,
  rateVersionSnapshot: z.array(RateVersionSchema),
  fx: fxSnapshot,
  markupPercent: z.number().min(0).max(100),
  lineItems: z.array(LineItemSchema),
  missing: z.array(MissingItemSchema),
  assumptions: z.array(NoteSchema),
  exclusions: z.array(NoteSchema),
  totals: CalculationTotalsSchema,
  calculatedAt: timestamp,
  expiresAt: timestamp,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  engineVersion: z.string().min(1),
});
export type CalculationResult = z.infer<typeof CalculationResultSchema>;

export const PublicHotelsQuerySchema = z.object({
  city: z
    .preprocess((value) => (typeof value === 'string' ? value.toLowerCase() : value), city)
    .optional(),
});
export type PublicHotelsQuery = z.infer<typeof PublicHotelsQuerySchema>;

/** One hotel as the public calculator lists it. No supplier contact details. */
export interface PublicHotel {
  id: string;
  city: 'makkah' | 'madinah';
  name: string;
  distanceMeters: number | null;
  distanceNote: string;
  transport: 'walking' | 'shuttle' | 'unknown';
  /** Nights covered by published packs that have a row for this hotel. */
  ratesFrom: string;
  ratesTo: string;
  /** Lowest published per-person sharing price per night, if any. */
  fromPerPerson: PublicFromPrice | null;
  /** Lowest published room-basis price per night, if any. */
  fromPerRoom: PublicFromPrice | null;
  /** Every published row for this hotel is "on booking": price on request only. */
  onRequestOnly: boolean;
}

export interface PublicFromPrice {
  /** Null when Settings hide supplier SAR rates (show "From PKR X" instead). */
  minorSAR: number | null;
  /** Null until an FX rate is set. */
  minorPKR: number | null;
  supplierName: string;
  packName: string;
  issueDate: string | null;
}
