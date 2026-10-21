/**
 * Schema assembly without a schema-building dependency.
 *
 * `graphql` can build a schema from SDL (`buildSchema`) and can execute it, but
 * `buildSchema` gives you a schema with no resolvers attached. `@graphql-tools/schema`
 * exists to bridge that gap; this file does the same job in ~30 lines, which keeps
 * the dependency list to `graphql` plus `dataloader`.
 *
 * The attachment is explicit and throws on a typo: a resolver named `conversionrate`
 * must fail at boot, not silently return null forever.
 */

import { GraphQLScalarType, buildSchema, isObjectType } from 'graphql';
import type { GraphQLFieldResolver, GraphQLSchema } from 'graphql';

import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

export function createSchema(): GraphQLSchema {
  const schema = buildSchema(typeDefs);
  attachResolvers(schema, resolvers);
  return schema;
}

type ResolverMap = Record<string, unknown>;

function attachResolvers(schema: GraphQLSchema, map: ResolverMap): void {
  for (const [typeName, entry] of Object.entries(map)) {
    const type = schema.getType(typeName);
    if (type === undefined) {
      throw new Error(`resolver declared for unknown type: ${typeName}`);
    }

    if (type instanceof GraphQLScalarType) {
      const scalar = entry as Partial<GraphQLScalarType>;
      if (typeof scalar.serialize === 'function') type.serialize = scalar.serialize;
      if (typeof scalar.parseValue === 'function') type.parseValue = scalar.parseValue;
      if (typeof scalar.parseLiteral === 'function') type.parseLiteral = scalar.parseLiteral;
      continue;
    }

    if (!isObjectType(type)) continue;

    const fields = type.getFields();
    for (const [fieldName, resolver] of Object.entries(entry as Record<string, unknown>)) {
      const field = fields[fieldName];
      if (field === undefined) {
        throw new Error(`resolver declared for unknown field: ${typeName}.${fieldName}`);
      }
      field.resolve = resolver as GraphQLFieldResolver<unknown, unknown>;
    }
  }
}
