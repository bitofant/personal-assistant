import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { bearerToken, parseCookies } from "./http.js";

describe("parseCookies", () => {
  it("parses, trims, decodes; first occurrence wins", () => {
    expect(parseCookies("a=1; b = x%20y ;a=2")).toEqual({ a: "1", b: "x y" });
  });

  it("ignores malformed parts and bad encoding", () => {
    expect(parseCookies("novalue; =x; c=%E0%A4%A; d=ok")).toEqual({ d: "ok" });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("bearerToken", () => {
  const req = (authorization?: string) => ({ headers: { authorization } }) as IncomingMessage;
  it("extracts the token, case-insensitive scheme", () => {
    expect(bearerToken(req("Bearer abc"))).toBe("abc");
    expect(bearerToken(req("bearer abc "))).toBe("abc");
  });
  it("rejects other schemes and missing header", () => {
    expect(bearerToken(req("Basic abc"))).toBeNull();
    expect(bearerToken(req("Bearer a b"))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });
});
