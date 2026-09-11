import { safeCopy } from "../../util/redact.ts";
import { relativeTime } from "../../util/time.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] ?? char,
  );
}

export function text(value: unknown): string {
  return escapeHtml(safeCopy(String(value ?? "")));
}

function markdownInline(value: string): string {
  const slots: string[] = [];
  const slot = (html: string): string => {
    const index = slots.push(html) - 1;
    return `\uE000${index}\uE001`;
  };
  let result = escapeHtml(value);
  result = result.replace(
    /`([^`\n]+)`/g,
    (_, code: string) => slot(`<code>${code}</code>`),
  );
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, _label: string, href: string) =>
      slot(`<a href="${href}" rel="noreferrer">${href}</a>`),
  );
  result = result.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  result = result.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  result = result.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  result = result.replace(
    /\uE000(\d+)\uE001/g,
    (_, index: string) => slots[Number(index)],
  );
  return result;
}

export function markdown(value: unknown): string {
  const lines = safeCopy(String(value ?? "")).replace(/\r\n?/g, "\n").split(
    "\n",
  );
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let listKind: "ul" | "ol" | undefined;
  let code: string[] | undefined;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p>${markdownInline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (!list.length || !listKind) return;
    blocks.push(`<${listKind}>${list.join("")}</${listKind}>`);
    list = [];
    listKind = undefined;
  };
  const flushText = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const fence = line.match(/^```(?:[A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      flushText();
      if (code) {
        blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = undefined;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushText();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushText();
      const level = heading[1].length;
      blocks.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      if (listKind && listKind !== kind) flushList();
      flushParagraph();
      listKind = kind;
      list.push(`<li>${markdownInline((bullet ?? ordered)![1])}</li>`);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (code) {
    blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  flushText();
  return `<div class="markdown">${blocks.join("")}</div>`;
}

export function money(value: number): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(7).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const abs = new Date(iso);
  const title = Number.isNaN(abs.getTime())
    ? iso
    : abs.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(title)}">${
    text(relativeTime(iso))
  }</time>`;
}

export function skSlot(kind: "table" | "block" = "block"): string {
  if (kind === "table") {
    return `<div class="sk-slot" hidden><div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div></div>`;
  }
  return `<div class="sk-slot" hidden><div class="sk"></div><div class="sk"></div></div>`;
}

export function layout(opts: {
  title: string;
  username?: string;
  active?: "activity" | "analytics" | "settings";
  body: string;
}): string {
  const right = opts.username
    ? `<div class="right">
    <a href="/activity"${
      opts.active === "activity"
        ? ` style="color:var(--text);font-weight:500"`
        : ""
    }>Activity</a>
    <a href="/analytics"${
      opts.active === "analytics"
        ? ` style="color:var(--text);font-weight:500"`
        : ""
    }>Usage</a>
    <a href="/settings"${
      opts.active === "settings"
        ? ` style="color:var(--text);font-weight:500"`
        : ""
    }>Settings</a>
    <span>${text(opts.username)}</span>
  </div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${
    text(opts.title)
  }</title><link rel="stylesheet" href="/styles.css"><link rel="icon" href="/logo.png" type="image/png"></head><body>
<div class="top"><div class="in">
  <a class="logo" href="/"><img src="/logo.png" alt="">co-maintainer</a>
  ${right}
</div></div>
${opts.body}
<div id="toasts"></div>
<script src="/client.js"></script>
</body></html>`;
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function repoNav(fullName: string, on: string): string {
  const short = text(fullName.split("/")[1] ?? fullName);
  const href = `/repos/${fullName}`;
  const item = (id: string, label: string, path: string) =>
    `<a href="${path}"${on === id ? ` class="on"` : ""}>${label}</a>`;
  return `<aside>
    <p class="lbl">${short}</p>
    <nav>
      ${item("overview", "Overview", href)}
      ${item("pulls", "Pull requests", `${href}/pulls`)}
      ${item("knowledge", "Knowledge", `${href}/knowledge`)}
      ${item("settings", "Settings", `${href}/settings`)}
    </nav>
  </aside>`;
}

export function empty(title: string, lead: string): string {
  return `<div class="empty"><h2>${text(title)}</h2><p>${text(lead)}</p></div>`;
}

export function statusClass(
  kind: "ok" | "warn" | "err" | "run",
  label: string,
): string {
  return `<span class="st ${kind}">${text(label)}</span>`;
}
