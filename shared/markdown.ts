import { Marked, type Tokens } from "marked";

// Single Markdown → HTML path (UI now; logs/exports later). Input is LLM output, which a transcript
// can steer (prompt injection by speech), so treat it as untrusted.

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SAFE_URL = /^(https?:|mailto:)/i;

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML shown as text, never injected.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    // Only http(s)/mailto links; `javascript:` etc. become plain text.
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href.trim())) return text;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    // No remote images: loading one on view would leak that the summary was opened.
    image({ text }: Tokens.Image) {
      return escapeHtml(text);
    },
  },
});

/** Synchronous (no async extensions). */
export function renderMarkdown(text: string): string {
  return md.parse(text, { async: false }) as string;
}
