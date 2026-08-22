import { describe, expect, it } from "vitest";
import { toMatchExpression } from "./search.js";

/**
 * SPEC §38.1 — a user query is data, not a query language.
 *
 * FTS5's MATCH syntax has operators: `NEAR`, `OR`, `*`, `^`, column filters, and quoting
 * rules of its own. A raw string from an agent is either a syntax error that surfaces as a
 * 500, or an operator the caller did not intend. Every term is quoted on the way in.
 */
describe("escaping a search query for FTS5", () => {
  it("quotes ordinary terms", () => {
    expect(toMatchExpression("cold start")).toBe('"cold" "start"');
  });

  it("neutralises FTS5 operators rather than executing them", () => {
    expect(toMatchExpression("cold OR start")).toBe('"cold" "or" "start"');
    expect(toMatchExpression("cold NEAR/2 start")).toBe('"cold" "near" "2" "start"');
    expect(toMatchExpression("col*")).toBe('"col"');
    expect(toMatchExpression("^cold")).toBe('"cold"');
    expect(toMatchExpression("title:cold")).toBe('"title" "cold"');
  });

  it("survives a quote, which would otherwise end the term early", () => {
    expect(toMatchExpression('cold" OR "x')).toBe('"cold" "or" "x"');
  });

  it("keeps letters from any script, and digits", () => {
    expect(toMatchExpression("холодный старт 42")).toBe('"холодный" "старт" "42"');
  });

  it("returns null when nothing usable is left, rather than an empty MATCH", () => {
    // An empty expression is a syntax error in FTS5; the caller returns no results instead.
    expect(toMatchExpression("   ")).toBeNull();
    expect(toMatchExpression("!!! ???")).toBeNull();
  });

  it("bounds the number of terms, so one query cannot become an expensive one", () => {
    const expression = toMatchExpression(Array.from({ length: 50 }, (_, i) => `t${i}`).join(" "));
    expect(expression?.split(" ")).toHaveLength(16);
  });
});
