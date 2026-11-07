import { expect } from "vitest";

/**
 * Pick the item with a given name out of a list, failing the test when it is absent.
 * @param items the list to search, each entry carrying a `name`
 * @param name the name to look for
 * @returns the matching entry
 */
export function named<T extends { name: string }>(items: readonly T[], name: string): T {
  return items.find((item) => item.name === name) ?? expect.unreachable(`${name} was not found`);
}

/**
 * Make a synchronous stub look like the asynchronous client method it replaces, so a
 * test double can answer with a plain value instead of an `async` function with no `await`.
 * @param fn the synchronous stub
 * @returns a function with the same parameters that resolves to the stub's result
 */
export function asyncStub<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => Promise<R> {
  return (...args) => Promise.resolve(fn(...args));
}
