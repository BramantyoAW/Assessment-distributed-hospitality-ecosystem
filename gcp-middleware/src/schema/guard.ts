/**
 * Query guard: reject a document that nests deeper than the schema intends.
 *
 * Why bother: GraphQL lets a client ask for `location { conversionRate { location {
 * conversionRate { … } } } }` and each level is another warehouse call. DataLoader
 * removes the N+1 *within* a level; it cannot remove a cycle. Without a depth cap
 * one request can walk the object graph until the query times out.
 *
 * Fragments are resolved while walking. A guard that only counts fields and skips
 * `...Fragment` is a guard you can bypass with two lines of GraphQL, so it is worth
 * the extra fifteen lines to follow the spreads.
 */

import { GraphQLError, Kind, parse } from 'graphql';
import type { DocumentNode, FragmentDefinitionNode, SelectionSetNode } from 'graphql';

/** Deep enough for `location { conversionRate { location { name } } }`, no more. */
export const MAX_DEPTH = 6;

export function measureDepth(document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  // Depth is counted the way a reader counts it: `{ locations { id } }` is 2.
  const walk = (selectionSet: SelectionSetNode, seen: ReadonlySet<string>): number => {
    let deepest = 0;

    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        const child = selection.selectionSet === undefined ? 0 : walk(selection.selectionSet, seen);
        deepest = Math.max(deepest, 1 + child);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        deepest = Math.max(deepest, walk(selection.selectionSet, seen));
      } else {
        const name = selection.name.value;
        // A cyclic fragment must not hang the guard itself.
        if (seen.has(name)) continue;
        const fragment = fragments.get(name);
        if (fragment === undefined) continue;
        deepest = Math.max(deepest, walk(fragment.selectionSet, new Set([...seen, name])));
      }
    }

    return deepest;
  };

  let deepest = 0;
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      deepest = Math.max(deepest, walk(definition.selectionSet, new Set()));
    }
  }

  return deepest;
}

/** Throws `GraphQLError` so the HTTP layer can return 400 with a usable message. */
export function assertDepth(source: string, max: number = MAX_DEPTH): number {
  const document = parse(source);
  const depth = measureDepth(document);
  if (depth > max) {
    throw new GraphQLError(`query is ${depth} levels deep, the maximum is ${max}`);
  }
  return depth;
}
