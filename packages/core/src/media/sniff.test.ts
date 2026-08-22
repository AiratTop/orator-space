import { describe, expect, it } from "vitest";
import { looksLikeXml, sniff, SNIFF_BYTES } from "./sniff.js";

/**
 * SPEC §21.1 — the type is what the bytes say, not what the header claims.
 *
 * The interesting cases here are not "a PNG is a PNG". They are the ones where a client
 * has an incentive to lie: an HTML document with an image extension, an SVG with a script
 * in it, a file whose first bytes are a container another format also uses.
 */

const bytes = (...values: (number | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number") out.push(value);
    else out.push(...[...value].map((c) => c.charCodeAt(0)));
  }
  return new Uint8Array([...out, ...new Array<number>(Math.max(0, SNIFF_BYTES - out.length)).fill(0)]);
};

const PNG = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const WEBP = bytes("RIFF", 0, 0, 0, 0, "WEBP");
const WAV = bytes("RIFF", 0, 0, 0, 0, "WAVE");
const PDF = bytes("%PDF-1.7");

describe("recognising a file", () => {
  it("names the formats it accepts", () => {
    expect(sniff(PNG)?.contentType).toBe("image/png");
    expect(sniff(JPEG)?.contentType).toBe("image/jpeg");
    expect(sniff(WEBP)?.contentType).toBe("image/webp");
    expect(sniff(PDF)?.contentType).toBe("application/pdf");
    expect(sniff(bytes(0, 0, 0, 0x20, "ftypavif"))?.contentType).toBe("image/avif");
    expect(sniff(bytes("OggS"))?.contentType).toBe("audio/ogg");
  });

  it("separates two formats that share the RIFF container", () => {
    // Both start with the same four bytes. Reading only those would file a sound recording
    // as an image, which is not a cosmetic error: it decides the Content-Type served back.
    expect(sniff(WEBP)?.kind).toBe("image");
    expect(sniff(WAV)?.kind).toBe("audio");
  });

  it("refuses a RIFF file that is neither", () => {
    expect(sniff(bytes("RIFF", 0, 0, 0, 0, "AVI "))).toBeNull();
  });

  it("requires the full PNG signature, not its first byte", () => {
    expect(sniff(bytes(0x89, "PNGX"))).toBeNull();
  });

  it("does not let the loose MP3 sync word swallow other formats", () => {
    // 0xFF starts an MPEG frame header and also starts a JPEG. The frame check is applied
    // last and demands the full sync word, so neither claims the other.
    expect(sniff(JPEG)?.contentType).toBe("image/jpeg");
    expect(sniff(bytes(0xff, 0xfb, 0x90))?.contentType).toBe("audio/mpeg");
    expect(sniff(bytes(0xff, 0x01, 0x02))).toBeNull();
  });

  it("returns null for anything not on the list", () => {
    // The allow-list's whole point: a format nobody considered is refused rather than
    // guessed at. A deny-list fails in the opposite, worse direction.
    expect(sniff(bytes("<!DOCTYPE html><script>"))).toBeNull();
    expect(sniff(bytes("MZ", 0x90))).toBeNull();
    expect(sniff(bytes("#!/bin/sh\n"))).toBeNull();
    expect(sniff(new Uint8Array(0))).toBeNull();
  });
});

describe("XML and SVG (ADR 0005)", () => {
  it("recognises SVG however it is introduced", () => {
    expect(looksLikeXml(bytes("<svg xmlns="))).toBe(true);
    expect(looksLikeXml(bytes('<?xml version="1.0"?><svg'))).toBe(true);
    expect(looksLikeXml(bytes("  \n<SVG "))).toBe(true);
    expect(looksLikeXml(bytes("<!DOCTYPE svg"))).toBe(true);
  });

  it("does not mistake a binary format for markup", () => {
    expect(looksLikeXml(PNG)).toBe(false);
    expect(looksLikeXml(PDF)).toBe(false);
  });

  it("is checked separately from the allow-list so the refusal can say why", () => {
    // An SVG would be refused either way — it matches no signature. It is detected on its
    // own so the caller is told "SVG is not accepted" rather than sent looking for a
    // corrupt file that is not corrupt.
    const svg = bytes("<svg xmlns=");
    expect(sniff(svg)).toBeNull();
    expect(looksLikeXml(svg)).toBe(true);
  });
});
