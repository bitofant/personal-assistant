import { describe, expect, it } from "vitest";
import { contentTypeFor, resolveStaticPath } from "./static.js";

const ROOT = "/srv/dist/web";

describe("resolveStaticPath", () => {
  it("maps asset paths inside root, ignoring query", () => {
    expect(resolveStaticPath(ROOT, "/assets/app.js?v=1")).toBe("/srv/dist/web/assets/app.js");
  });

  it("returns null for root (SPA index)", () => {
    expect(resolveStaticPath(ROOT, "/")).toBeNull();
  });

  it("blocks traversal, including encoded and sibling-prefix escapes", () => {
    expect(resolveStaticPath(ROOT, "/../../etc/passwd")).toBeNull();
    expect(resolveStaticPath(ROOT, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveStaticPath(ROOT, "/..%2fweb.prev/index.html")).toBeNull();
  });

  it("rejects malformed encoding and NUL bytes", () => {
    expect(resolveStaticPath(ROOT, "/%E0%A4%A")).toBeNull();
    expect(resolveStaticPath(ROOT, "/a%00.js")).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("knows common types, defaults to octet-stream", () => {
    expect(contentTypeFor("/x/a.js")).toBe("text/javascript");
    expect(contentTypeFor("/x/a.bin")).toBe("application/octet-stream");
  });
});
