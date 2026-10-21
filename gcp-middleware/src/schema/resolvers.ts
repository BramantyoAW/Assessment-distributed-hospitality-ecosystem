/**
 * Resolvers. Thin by design: every rule that could be wrong (dedupe, aggregate
 * before join, conversion rate) lives in the gateway, so it is implemented once
 * for SQL and once for memory, and tested there.
 *
 * What stays here is request-shaped work: clamping `limit`, rejecting malformed
 * dates, and going through DataLoader instead of the gateway directly.
 */

import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import type { GraphQLFieldResolver } from 'graphql';

import type {
  BigQueryGateway,
  ConversionRecord,
  LocationRecord,
  TransactionFact,
  VisitBucket,
  VisitorCountRecord,
} from '../bigquery/gateway.js';
import { conversionKey } from '../dataloader/loaders.js';
import type { Loaders } from '../dataloader/loaders.js';

export interface GraphQLContext {
  readonly gateway: BigQueryGateway;
  readonly loaders: Loaders;
}

/** Default page caps, exported so the guard and the schema docs agree. */
export const DEFAULT_TRANSACTION_LIMIT = 50;
export const DEFAULT_VISITOR_LIMIT = 168;
export const MAX_LIMIT = 500;

/**
 * `limit` is clamped, never rejected: a client asking for 10,000 rows gets 500 and
 * a working response. Failing the request instead would be a denial of service
 * handed to the caller.
 */
export function clampLimit(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date, validated rather than trusted: `2026-02-31` is not a date. */
export function assertDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new GraphQLError(`${field} must be an ISO date (YYYY-MM-DD)`);
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new GraphQLError(`${field} is not a real calendar date`);
  }

  return value;
}

const DateScalar = new GraphQLScalarType({
  name: 'Date',
  description: 'ISO 8601 calendar date: YYYY-MM-DD.',
  serialize: (value) => assertDate(value, 'Date'),
  parseValue: (value) => assertDate(value, 'Date'),
  parseLiteral: (ast) =>
    ast.kind === Kind.STRING ? assertDate(ast.value, 'Date') : new GraphQLError('Date must be a string'),
});

const locationOf: GraphQLFieldResolver<{ locationId: string }, GraphQLContext, unknown> = (
  parent,
  _args,
  context,
) => context.loaders.location.load(parent.locationId);

export const resolvers = {
  Date: DateScalar,

  Query: {
    locations: (_parent: unknown, _args: unknown, context: GraphQLContext) => context.gateway.listLocations(),

    location: (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
      context.loaders.location.load(args.id),

    transactions: (
      _parent: unknown,
      args: { locationId: string; from: string; to: string; limit?: number | null },
      context: GraphQLContext,
    ) =>
      context.gateway.listTransactions({
        locationId: args.locationId,
        from: assertDate(args.from, 'from'),
        to: assertDate(args.to, 'to'),
        limit: clampLimit(args.limit, DEFAULT_TRANSACTION_LIMIT),
      }),

    visitorCounts: (
      _parent: unknown,
      args: {
        locationId: string;
        from: string;
        to: string;
        bucket?: VisitBucket | null;
        limit?: number | null;
      },
      context: GraphQLContext,
    ) =>
      context.gateway.visitorCounts({
        locationId: args.locationId,
        from: assertDate(args.from, 'from'),
        to: assertDate(args.to, 'to'),
        bucket: args.bucket ?? 'HOUR',
        limit: clampLimit(args.limit, DEFAULT_VISITOR_LIMIT),
      }),

    conversionRate: (
      _parent: unknown,
      args: { locationId: string; date: string },
      context: GraphQLContext,
    ) =>
      context.loaders.conversion.load(conversionKey(args.locationId, assertDate(args.date, 'date'))),
  },

  Location: {
    id: (parent: LocationRecord) => parent.locationId,

    conversionRate: (parent: LocationRecord, args: { date: string }, context: GraphQLContext) =>
      context.loaders.conversion.load(conversionKey(parent.locationId, assertDate(args.date, 'date'))),

    visitorCounts: (
      parent: LocationRecord,
      args: { from: string; to: string; bucket?: VisitBucket | null; limit?: number | null },
      context: GraphQLContext,
    ) =>
      context.gateway.visitorCounts({
        locationId: parent.locationId,
        from: assertDate(args.from, 'from'),
        to: assertDate(args.to, 'to'),
        bucket: args.bucket ?? 'HOUR',
        limit: clampLimit(args.limit, DEFAULT_VISITOR_LIMIT),
      }),
  },

  Transaction: {
    id: (parent: TransactionFact) => parent.transactionId,
    location: locationOf,
    occurredAtSource: (parent: TransactionFact) => parent.occurredAtSource.toUpperCase(),
  },

  VisitorCount: {
    location: locationOf,
  },

  ConversionRate: {
    location: (parent: ConversionRecord, _args: unknown, context: GraphQLContext) =>
      context.loaders.location.load(parent.locationId),
    date: (parent: ConversionRecord) => parent.businessDate,
    conversionRate: (parent: ConversionRecord) => parent.conversionRate,
  },
};

/** Discriminated shape used by tests and by the schema smoke test. */
export type { LocationRecord, TransactionFact, VisitorCountRecord, ConversionRecord };
