import { describe, expect, it } from "vitest";
import { addressPseudonym } from "./pseudonym.js";

describe("addressPseudonym", () => {
  it("stores nothing for a caller whose address is unknown", async () => {
    expect(await addressPseudonym(null, "pepper")).toBeNull();
  });

  it("is stable, or the audit log cannot correlate and the flood key cannot count", async () => {
    expect(await addressPseudonym("203.0.113.7", "pepper")).toBe(
      await addressPseudonym("203.0.113.7", "pepper"),
    );
  });

  it("separates two callers", async () => {
    expect(await addressPseudonym("203.0.113.7", "pepper")).not.toBe(
      await addressPseudonym("203.0.113.8", "pepper"),
    );
  });

  it("is keyed: the same address under two peppers shares nothing", async () => {
    expect(await addressPseudonym("203.0.113.7", "one")).not.toBe(
      await addressPseudonym("203.0.113.7", "two"),
    );
  });

  it("is 128 bits of hex, and not the address", async () => {
    const pseudonym = await addressPseudonym("203.0.113.7", "pepper");
    expect(pseudonym).toMatch(/^[0-9a-f]{32}$/);
    expect(pseudonym).not.toContain("203");
  });
});
