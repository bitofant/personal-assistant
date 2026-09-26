import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders the summary shape (headings, lists, emphasis)", () => {
    const html = renderMarkdown("## Summary\n* one\n* **two**\n\n## Action items\n- Bob: write JD");
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<li><strong>two</strong></li>");
    expect(html).toContain("<li>Bob: write JD</li>");
  });

  it("escapes raw HTML, block and inline", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nhi <img src=x onerror="alert(1)"> there');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("keeps http(s)/mailto links (new tab, no opener), drops other schemes", () => {
    expect(renderMarkdown("[doc](https://example.com/a?b=1&c=2)")).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">doc</a>',
    );
    expect(renderMarkdown("[mail](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x"]) {
      const html = renderMarkdown(`[click](${bad})`);
      expect(html).not.toContain("<a");
      expect(html).toContain("click");
    }
  });

  it("images become their alt text (no remote loads)", () => {
    const html = renderMarkdown('![tracking <b>](https://evil.example/pixel.png)');
    expect(html).not.toMatch(/<img|evil\.example/);
    expect(html).toContain("tracking &lt;b&gt;");
  });

  it("escapes quotes in link titles", () => {
    expect(renderMarkdown('[x](https://a.b "say \\"hi\\"")')).toContain('title="say &quot;hi&quot;"');
  });
});
