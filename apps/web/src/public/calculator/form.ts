/**
 * Calculator form state and the checks we can make before asking the server
 * (docs/01 section 4). The server checks everything again; these only give
 * quick, translated messages.
 */
import {
  MAX_NIGHTS_PER_CITY,
  MAX_ROOMS,
  MAX_TRAVELERS,
  OCCUPANCY_BEDS,
  WHOLE_ROOM_MAX_PERSONS,
  type CalculateInputBody,
  type Extra,
  type RoomOccupancy,
} from '@marafiq/shared';
import { todayInPakistan } from '../format';

export const OTHER_CITY = '__other__';

export interface RoomState {
  key: number;
  occupancy: RoomOccupancy;
  persons: number;
}

export interface FormState {
  /** A city from config, OTHER_CITY, or '' for none chosen. */
  departureCity: string;
  otherCity: string;
  arrivalDate: string;
  flexibilityDays: number;
  nightsMakkah: number;
  nightsMadinah: number;
  order: 'makkah_first' | 'madinah_first';
  adults: number;
  children: number;
  infants: number;
  rooms: RoomState[];
  makkahHotel: string;
  madinahHotel: string;
  visa: 'direct' | 'indirect';
  flight: 'estimate' | 'self';
  extras: Extra[];
}

export const initialForm = (): FormState => ({
  departureCity: '',
  otherCity: '',
  arrivalDate: '',
  flexibilityDays: 0,
  nightsMakkah: 5,
  nightsMadinah: 4,
  order: 'makkah_first',
  adults: 2,
  children: 0,
  infants: 0,
  rooms: [{ key: 1, occupancy: 'double', persons: 2 }],
  makkahHotel: 'cheapest',
  madinahHotel: 'cheapest',
  visa: 'direct',
  flight: 'estimate',
  extras: [],
});

export const bedsIn = (occupancy: RoomOccupancy) =>
  occupancy === 'whole_room' ? WHOLE_ROOM_MAX_PERSONS : OCCUPANCY_BEDS[occupancy];

export const peopleInRooms = (form: FormState) =>
  form.rooms.reduce((sum, room) => sum + room.persons, 0);

/** Field id -> translation key. Ids match the server's field paths where they exist. */
export type FormErrors = Record<string, string>;

export function validate(form: FormState, now: Date = new Date()): FormErrors {
  const errors: FormErrors = {};
  if (!form.arrivalDate) errors.arrivalDate = 'calc.errors.dateRequired';
  else if (form.arrivalDate < todayInPakistan(now)) errors.arrivalDate = 'calc.errors.datePast';

  const nights = (n: number) => Number.isInteger(n) && n >= 0 && n <= MAX_NIGHTS_PER_CITY;
  if (!nights(form.nightsMakkah)) errors.nightsMakkah = 'calc.errors.nightsRange';
  if (!nights(form.nightsMadinah)) errors.nightsMadinah = 'calc.errors.nightsRange';
  if (!errors.nightsMakkah && !errors.nightsMadinah && form.nightsMakkah + form.nightsMadinah < 1) {
    errors.nightsMakkah = 'calc.errors.nightsNone';
  }

  if (!Number.isInteger(form.adults) || form.adults < 1)
    errors['travelers.adults'] = 'calc.errors.adults';
  for (const field of ['children', 'infants'] as const) {
    if (!Number.isInteger(form[field]) || form[field] < 0)
      errors[`travelers.${field}`] = 'calc.errors.count';
  }
  if (form.adults + form.children + form.infants > MAX_TRAVELERS)
    errors.travelers = 'calc.errors.tooMany';

  form.rooms.forEach((room, index) => {
    if (
      !Number.isInteger(room.persons) ||
      room.persons < 1 ||
      room.persons > bedsIn(room.occupancy)
    ) {
      errors[`rooms.${index}.persons`] = 'calc.errors.roomBeds';
    }
  });
  if (form.rooms.length > MAX_ROOMS) errors.rooms = 'calc.errors.tooManyRooms';
  else if (peopleInRooms(form) !== form.adults + form.children)
    errors.rooms = 'calc.errors.roomsMatch';
  return errors;
}

export function toInput(form: FormState): CalculateInputBody {
  const city = form.departureCity === OTHER_CITY ? form.otherCity.trim() : form.departureCity;
  return {
    departureCity: city,
    arrivalDate: form.arrivalDate,
    flexibilityDays: form.flexibilityDays,
    nightsMakkah: form.nightsMakkah,
    nightsMadinah: form.nightsMadinah,
    order: form.order,
    travelers: { adults: form.adults, children: form.children, infants: form.infants },
    rooms: form.rooms.map(({ occupancy, persons }) => ({ occupancy, persons })),
    hotels: {
      ...(form.nightsMakkah > 0 ? { makkah: form.makkahHotel } : {}),
      ...(form.nightsMadinah > 0 ? { madinah: form.madinahHotel } : {}),
    },
    visa: form.visa,
    // "Other city" has no estimate: the result then says "Request a quote".
    flight: form.flight,
    extras: form.extras,
  };
}
