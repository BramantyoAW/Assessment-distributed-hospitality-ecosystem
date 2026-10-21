/**
 * The GraphQL contract.
 *
 * Shape rules that are decisions, not accidents:
 *
 * - `guests: Int` is nullable. Not every NetSuite row carries a guest count, and
 *   defaulting it to 0 would turn "unknown" into "zero guests" in every average.
 * - `occurredAt` is nullable and paired with `occurredAtSource`. The source field
 *   says whether the timestamp came from the record or was unavailable, so a
 *   client can tell "no timestamp" from "midnight default".
 * - `amount` and `totalRevenue` are `String`, not `Float`. NUMERIC on the way in
 *   and a float on the way out would reintroduce the rounding the column type was
 *   chosen to avoid.
 * - `conversionRate: Float` is nullable. `null` means "no camera data, so not
 *   measurable"; 0 means "measured, nobody converted". Collapsing those two into
 *   one value is how a dashboards shows 0% for a location whose camera is offline.
 * - `limit` arguments are clamped by the resolver to `MAX_QUERY_ROWS`; the schema
 *   documents the default, the resolver enforces the ceiling.
 */

export const typeDefs = `#graphql
  """ISO 8601 calendar date: YYYY-MM-DD."""
  scalar Date

  enum VisitBucket {
    HOUR
    DAY
  }

  enum OccurredAtSource {
    RECORD
    UNAVAILABLE
  }

  type Location {
    id: ID!
    name: String!
    area: String
    capacity: Int
    isOutdoor: Boolean!
    timezone: String!

    "Conversion metrics for one business day."
    conversionRate(date: Date!): ConversionRate

    "Camera readings for a range, aggregated per bucket."
    visitorCounts(from: Date!, to: Date!, bucket: VisitBucket = HOUR, limit: Int = 168): [VisitorCount!]!
  }

  type Transaction {
    id: ID!
    location: Location!
    businessDate: Date!
    "Null when the source row had no usable timestamp; see occurredAtSource."
    occurredAt: String
    occurredAtSource: OccurredAtSource!
    sourceCreatedAt: String
    sourceModifiedAt: String!
    "Decimal string, not Float: NUMERIC precision must survive the wire."
    amount: String!
    currency: String!
    txnType: String!
    "Nullable: null means the source did not say, which is not zero."
    guests: Int
  }

  type VisitorCount {
    location: Location!
    "ISO 8601 start of the bucket, in the venue timezone."
    bucketStart: String!
    "SUM(people_count): sightings, not distinct humans."
    visits: Int!
    readings: Int!
    cameraSeconds: Int!
  }

  type ConversionRate {
    location: Location!
    date: Date!
    totalTransactions: Int!
    "Decimal string, not Float."
    totalRevenue: String!
    totalVisits: Int!
    totalReadings: Int!
    cameraSeconds: Int!
    "transactions / visits. Null when there is no camera data to divide by."
    conversionRate: Float
  }

  type Query {
    locations: [Location!]!
    location(id: ID!): Location
    transactions(locationId: ID!, from: Date!, to: Date!, limit: Int = 50): [Transaction!]!
    visitorCounts(locationId: ID!, from: Date!, to: Date!, bucket: VisitBucket = HOUR, limit: Int = 168): [VisitorCount!]!
    conversionRate(locationId: ID!, date: Date!): ConversionRate
  }
`;
