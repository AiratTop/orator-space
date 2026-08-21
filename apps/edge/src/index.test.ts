import { describe, expect, it } from "vitest";
import { surfaceFor } from "./index.js";

describe("hostname routing (SPEC §63)", () => {
  it("maps each public surface onto the one Worker", () => {
    expect(surfaceFor("api.orator.space")).toBe("api");
    expect(surfaceFor("mcp.orator.space")).toBe("mcp");
    expect(surfaceFor("media.orator.space")).toBe("media");
  });

  it("resolves staging hostnames the same way", () => {
    // Single-level names, forced by Universal SSL covering only one subdomain level.
    expect(surfaceFor("api-staging.orator.space")).toBe("api");
    expect(surfaceFor("mcp-staging.orator.space")).toBe("mcp");
    expect(surfaceFor("media-staging.orator.space")).toBe("media");
  });

  it("does not claim hostnames belonging to the web app", () => {
    expect(surfaceFor("orator.space")).toBe("unknown");
    expect(surfaceFor("www.orator.space")).toBe("unknown");
    expect(surfaceFor("staging.orator.space")).toBe("unknown");
  });

  it("ignores a bare suffix that does not name a surface", () => {
    expect(surfaceFor("docs-staging.orator.space")).toBe("unknown");
    expect(surfaceFor("apibogus.orator.space")).toBe("unknown");
  });
});
