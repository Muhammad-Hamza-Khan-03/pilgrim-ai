import { createHash } from 'node:crypto';
import type { ActualUmrahRateRow, ActualUmrahRates } from './actual-umrah.js';

export const ACTUAL_UMRAH_CITY_ALIASES = {
  'Makkah Mukarramah': 'Makkah',
  'Madinah Munawarrah': 'Madinah',
  'Madinah Munawwarrah': 'Madinah',
} as const;

export const ACTUAL_UMRAH_OCCUPANCY_MAPPINGS = [
  { column: 'DBL', roomType: 'dbl', capacity: 2 },
  { column: 'TRP', roomType: 'trp', capacity: 3 },
  { column: 'QUAD', roomType: 'quad', capacity: 4 },
  { column: 'Suite for 5 Persons', roomType: 'suite_5', capacity: 5 },
] as const;

type City = 'Makkah' | 'Madinah';
type OccupancyColumn = (typeof ACTUAL_UMRAH_OCCUPANCY_MAPPINGS)[number]['column'];
type RoomType = (typeof ACTUAL_UMRAH_OCCUPANCY_MAPPINGS)[number]['roomType'];

export interface CanonicalSourceRef {
  sourceId: string;
  sha256: string;
  rowNumber: number;
  raw: string;
  rawValues: string[];
}

export interface CanonicalHotel {
  id: string;
  name: string;
  city: City;
  cityRaw: string;
  provisional: true;
  source: CanonicalSourceRef;
  rooms: CanonicalRoom[];
}

export interface CanonicalRoom {
  id: string;
  hotelId: string;
  roomType: RoomType;
  capacity: number;
  provisional: true;
  source: CanonicalSourceRef;
  rates: CanonicalRate[];
}

export interface CanonicalRate {
  id: string;
  hotelId: string;
  roomId: string;
  hotelName: string;
  city: City;
  cityRaw: string;
  roomType: RoomType;
  capacity: number;
  price: number;
  currency: 'SAR';
  priceBasis: 'per room per night';
  provisional: true;
  mealPlan: string;
  validFrom: string;
  validTo: string;
  validFromRaw: string;
  validToRaw: string;
  source: CanonicalSourceRef;
}

export interface CanonicalPeriod {
  validFrom: string;
  validTo: string;
  validFromRaw: string;
  validToRaw: string;
}

export interface BlankCellLedgerEntry {
  rowNumber: number;
  column: OccupancyColumn;
  rawValue: '';
  reason: 'unavailable';
  sourceId: string;
  sha256: string;
  raw: string;
  rawValues: string[];
}

export interface ActualUmrahCanonicalStaging {
  status: 'staging';
  recommenderReady: false;
  semantics: {
    currency: 'SAR';
    priceBasis: 'per room per night';
    provisional: true;
  };
  source: {
    sourceId: string;
    sha256: string;
    byteLength: number;
    rowCount: number;
  };
  hotels: CanonicalHotel[];
  rooms: CanonicalRoom[];
  rates: CanonicalRate[];
  periods: CanonicalPeriod[];
  blankCells: BlankCellLedgerEntry[];
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function city(raw: string): City {
  const mapped = ACTUAL_UMRAH_CITY_ALIASES[raw as keyof typeof ACTUAL_UMRAH_CITY_ALIASES];
  if (mapped === undefined) throw new Error(`ACTUAL_UMRAH_INVALID: unsupported city alias ${raw}`);
  return mapped;
}

function sourceRef(source: ActualUmrahRates, row: ActualUmrahRateRow): CanonicalSourceRef {
  return {
    sourceId: source.sourceId,
    sha256: source.sha256,
    rowNumber: row.rowNumber,
    raw: row.raw,
    rawValues: [...row.rawValues],
  };
}

function compareRows(left: ActualUmrahRateRow, right: ActualUmrahRateRow): number {
  return left.rowNumber - right.rowNumber
    || left.raw.localeCompare(right.raw)
    || JSON.stringify(left.rawValues).localeCompare(JSON.stringify(right.rawValues));
}

export function mapActualUmrahRatesToCanonical(source: ActualUmrahRates): ActualUmrahCanonicalStaging {
  const hotels: CanonicalHotel[] = [];
  const hotelByKey = new Map<string, CanonicalHotel>();
  const rooms: CanonicalRoom[] = [];
  const rates: CanonicalRate[] = [];
  const periods: CanonicalPeriod[] = [];
  const periodKeys = new Set<string>();
  const blankCells: BlankCellLedgerEntry[] = [];
  const rateOccurrences = new Map<string, number>();

  // Sort by source provenance, not caller iteration order. This also makes the
  // first row a deterministic representative for hotel/room/period provenance.
  for (const row of [...source.rows].sort(compareRows)) {
    const mappedCity = city(row.city);
    const hotelKey = `${mappedCity}\u0000${row.hotelName}`;
    let hotel = hotelByKey.get(hotelKey);
    if (hotel === undefined) {
      const ref = sourceRef(source, row);
      hotel = {
        id: stableId('hotel', source.sourceId, hotelKey),
        name: row.hotelName,
        city: mappedCity,
        cityRaw: row.city,
        provisional: true,
        source: ref,
        rooms: [],
      };
      hotelByKey.set(hotelKey, hotel);
      hotels.push(hotel);
    }

    const periodKey = `${row.periodFrom.iso}\u0000${row.periodTo.iso}`;
    if (!periodKeys.has(periodKey)) {
      periodKeys.add(periodKey);
      periods.push({
        validFrom: row.periodFrom.iso,
        validTo: row.periodTo.iso,
        validFromRaw: row.periodFrom.raw,
        validToRaw: row.periodTo.raw,
      });
    }

    for (const mapping of ACTUAL_UMRAH_OCCUPANCY_MAPPINGS) {
      const rawValue = row.rawValues[4 + ACTUAL_UMRAH_OCCUPANCY_MAPPINGS.indexOf(mapping)];
      if (rawValue === '') {
        blankCells.push({
          rowNumber: row.rowNumber,
          column: mapping.column,
          rawValue: '',
          reason: 'unavailable',
          sourceId: source.sourceId,
          sha256: source.sha256,
          raw: row.raw,
          rawValues: [...row.rawValues],
        });
        continue;
      }

      let room = hotel.rooms.find((candidate) => candidate.roomType === mapping.roomType);
      if (room === undefined) {
        const ref = sourceRef(source, row);
        room = {
          id: stableId('room', hotel.id, mapping.roomType),
          hotelId: hotel.id,
          roomType: mapping.roomType,
          capacity: mapping.capacity,
          provisional: true,
          source: ref,
          rates: [],
        };
        hotel.rooms.push(room);
        rooms.push(room);
      }

      const price = row.occupancyValues[mapping.column];
      if (price === null) throw new Error(`ACTUAL_UMRAH_INVALID: ${mapping.column} is blank but raw value is nonblank`);
      const ref = sourceRef(source, row);
      const contentKey = JSON.stringify([
        hotelKey,
        mapping.roomType,
        row.periodFrom.iso,
        row.periodTo.iso,
        row.periodFrom.raw,
        row.periodTo.raw,
        row.city,
        row.hotelName,
        row.mealPlan,
        price,
      ]);
      const occurrence = rateOccurrences.get(contentKey) ?? 0;
      rateOccurrences.set(contentKey, occurrence + 1);
      const rate: CanonicalRate = {
        id: stableId('rate', contentKey, String(occurrence)),
        hotelId: hotel.id,
        roomId: room.id,
        hotelName: hotel.name,
        city: hotel.city,
        cityRaw: row.city,
        roomType: mapping.roomType,
        capacity: mapping.capacity,
        price,
        currency: 'SAR',
        priceBasis: 'per room per night',
        provisional: true,
        mealPlan: row.mealPlan,
        validFrom: row.periodFrom.iso,
        validTo: row.periodTo.iso,
        validFromRaw: row.periodFrom.raw,
        validToRaw: row.periodTo.raw,
        source: ref,
      };
      room.rates.push(rate);
      rates.push(rate);
    }
  }

  return {
    status: 'staging',
    recommenderReady: false,
    semantics: { currency: 'SAR', priceBasis: 'per room per night', provisional: true },
    source: { sourceId: source.sourceId, sha256: source.sha256, byteLength: source.byteLength, rowCount: source.rows.length },
    hotels,
    rooms,
    rates,
    periods,
    blankCells,
  };
}
