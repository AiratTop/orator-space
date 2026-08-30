import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./version.js";
import { readVersioned, versioned } from "./versioned.js";

describe("versioned (SPEC §46.4)", () => {
  it("stamps the current version", () => {
    expect(versioned({ source: "blog.example" })).toEqual({
      source: "blog.example",
      schema_version: SCHEMA_VERSION,
    });
  });

  it("does not let the caller's object decide what version the row claims to be", () => {
    // The whole point: the one field a migration has to trust cannot be set by the party
    // whose data is being versioned.
    expect(versioned({ schema_version: 99, note: "mine" }).schema_version).toBe(SCHEMA_VERSION);
    expect(versioned({ schema_version: "banana" } as Record<string, unknown>).schema_version).toBe(
      SCHEMA_VERSION,
    );
  });

  it("keeps everything else the caller sent", () => {
    expect(versioned({ a: 1, b: { c: [2, 3] } })).toMatchObject({ a: 1, b: { c: [2, 3] } });
  });
});

describe("readVersioned (SPEC §46.4)", () => {
  it("has nothing to say about a column that is null", () => {
    expect(readVersioned(null)).toBeNull();
    expect(readVersioned(undefined)).toBeNull();
  });

  it("reads a version it knows", () => {
    expect(readVersioned(JSON.stringify(versioned({ model: "x" })))).toEqual({
      model: "x",
      schema_version: SCHEMA_VERSION,
    });
  });

  it("reads a blob written before anything stamped one as version 0", () => {
    expect(readVersioned('{"model":"x"}')).toEqual({ model: "x", schema_version: 0 });
  });

  it("refuses a version that is present and is not one", () => {
    // Distinct from the case above, and that distinction is the point: absence is a fact
    // about an old row, a nonsense value is a fact about a corrupt one, and a reader that
    // conflates them migrates the corrupt row as though it were legacy.
    for (const bad of ['"banana"', "null", "1.5", "-1", "true", '{"a":1}']) {
      expect(() => readVersioned(`{"schema_version":${bad}}`), bad).toThrow(TypeError);
    }
  });

  it("refuses a version from a build that has not shipped here yet (§65)", () => {
    expect(() => readVersioned(`{"schema_version":${SCHEMA_VERSION + 1}}`)).toThrow(RangeError);
  });

  it("refuses a root that is not an object, which every caller spreads", () => {
    for (const root of ["null", "[]", "7", '"text"', "true"]) {
      expect(() => readVersioned(root), root).toThrow(TypeError);
    }
  });

  it("still refuses malformed JSON, rather than inventing a blob", () => {
    expect(() => readVersioned("{not json")).toThrow();
  });
});
