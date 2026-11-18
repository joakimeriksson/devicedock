// The few assertions the tests use, on Deno's standard library (no Node). Same names and argument order as
// node:assert/strict, so a test reads assert.equal(actual, expected, message).
import {
  assert as ok,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";

const message = (e) => (e instanceof Error ? e.message : String(e));

export default {
  ok: (value, msg) => ok(value, msg),
  equal: (actual, expected, msg) => assertStrictEquals(actual, expected, msg),
  deepEqual: (actual, expected, msg) => assertEquals(actual, expected, msg),
  match: (actual, re, msg) => assertMatch(actual, re, msg),
  /** Passes when fn throws an error whose message matches `re`. */
  throws: (fn, re, msg) => assertMatch(message(assertThrows(fn, msg)), re, msg),
  /** Passes when the promise rejects with an error whose message matches `re`. */
  rejects: async (promise, re, msg) => assertMatch(message(await assertRejects(() => promise, msg)), re, msg),
};
