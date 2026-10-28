/** Design-system components, pure string builders.
 *
 * Every class name here comes from the stylesheet block scoped to `.app` /
 * `.focus` (see `styles.css`), so a page must render inside one of those
 * wrappers to be styled. Callers pass pre-escaped HTML for content that may
 * contain markup (table cells, alert bodies); `text()` is the default for
 * plain strings.
 *
 * `field()` always links its label and control, which is what keeps the
 * accessibility sweep honest: a control without an accessible name has no
 * place to hide here.
 */
import { escapeHtml, text } from "./layout.ts";
import { iconNames, sprite } from "./icons.ts";

export { sprite as iconSprite, iconNames };

const KNOWN = new Set<string>(iconNames);

/** One inline lucide icon from the embedded sprite. An unknown name renders
 * nothing rather than a broken `<use>`, so a typo degrades to no icon instead
 * of an empty box. */
export function icon(name: string, cls = ""): string {
  if (!KNOWN.has(name)) return "";
  const extra = cls ? ` ${cls}` : "";
  return `<svg class="ic${extra}" aria-hidden="true"><use href="#i-${escapeHtml(
    name,
  )}"></use></svg>`;
}

export function pageHeader(opts: {
  title: string;
  lead?: string;
  crumb?: string;
  actions?: string;
}): string {
  return `<div class="ph">
  <div>${opts.crumb ?? ""}<h1>${text(opts.title)}</h1>${
    opts.lead ? `<div class="d">${text(opts.lead)}</div>` : ""
  }</div>
  ${opts.actions ? `<div class="actions-row">${opts.actions}</div>` : ""}
</div>`;
}

export function crumb(items: { label: string; href?: string }[]): string {
  return `<div class="crumb">${items
    .map((item, i) => {
      const node = item.href
        ? `<a href="${escapeHtml(item.href)}">${text(item.label)}</a>`
        : `<span>${text(item.label)}</span>`;
      return i === 0 ? node : `${icon("chevron-right")}${node}`;
    })
    .join("")}</div>`;
}

export function tabs(
  items: { label: string; href: string; on?: boolean; count?: number }[],
): string {
  return `<nav class="tabs">${items
    .map(
      (item) =>
        `<a href="${escapeHtml(item.href)}"${item.on ? ` class="on"` : ""}>${text(
          item.label,
        )}${
          item.count !== undefined
            ? `<span class="cnt">${text(String(item.count))}</span>`
            : ""
        }</a>`,
    )
    .join("")}</nav>`;
}

export function card(
  body: string,
  opts: { flush?: boolean; red?: boolean; class?: string } = {},
): string {
  const cls = [
    "card",
    opts.flush ? "flush" : "",
    opts.red ? "red" : "",
    opts.class ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="${cls}">${body}</div>`;
}

export function section(
  body: string,
  opts: {
    title?: string;
    count?: number;
    action?: string;
    lead?: string;
    class?: string;
  } = {},
): string {
  const header = opts.title
    ? `<h2>${text(opts.title)}${
        opts.count !== undefined ? `<span class="cnt">${opts.count}</span>` : ""
      }${opts.action ? `<span class="act">${opts.action}</span>` : ""}</h2>`
    : "";
  const lead = opts.lead ? `<div class="lead">${text(opts.lead)}</div>` : "";
  return `<div class="sec${opts.class ? ` ${opts.class}` : ""}">${header}${lead}${body}</div>`;
}

export function foot(body: string): string {
  return `<div class="foot">${body}</div>`;
}

export function table(opts: {
  head: string[];
  rows: string[][];
  empty?: string;
}): string {
  if (opts.rows.length === 0 && opts.empty) {
    return `<div class="sec"><p class="muted">${text(opts.empty)}</p></div>`;
  }
  return `<table><thead><tr>${opts.head
    .map((cell) => `<th>${cell}</th>`)
    .join("")}</tr></thead><tbody>${opts.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

export type Tone = "emerald" | "amber" | "red" | "sky" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  emerald: "b-em",
  amber: "b-am",
  red: "b-red",
  sky: "b-sky",
  neutral: "b-ne",
};

export function badge(
  tone: Tone,
  label: string,
  opts: { icon?: string; class?: string } = {},
): string {
  return `<span class="badge ${TONE_CLASS[tone]}${opts.class ? ` ${opts.class}` : ""}">${
    opts.icon ? icon(opts.icon) : ""
  }${text(label)}</span>`;
}

export function statCard(opts: {
  label: string;
  value: string;
  hint?: string;
  icon?: string;
}): string {
  return `<div class="stat">
  <div class="top">${text(opts.label)}${
    opts.icon ? `<span class="ic">${icon(opts.icon)}</span>` : ""
  }</div>
  <div class="v">${opts.value}</div>
  ${opts.hint ? `<div class="h">${opts.hint}</div>` : ""}
</div>`;
}

export function segmented(
  items: {
    label: string;
    on?: boolean;
    tag?: string;
    tagRec?: boolean;
    icon?: string;
    attrs?: string;
  }[],
): string {
  return `<div class="seg">${items
    .map(
      (item) =>
        `<button type="button"${item.on ? ` class="on"` : ""}${
          item.attrs ? ` ${item.attrs}` : ""
        }>${item.icon ? icon(item.icon) : ""}${text(item.label)}${
          item.tag
            ? `<span class="tag${item.tagRec ? " rec" : ""}">${text(
                item.tag,
              )}</span>`
            : ""
        }</button>`,
    )
    .join("")}</div>`;
}

/** A labelled switch. `label` is required because it becomes the control's
 * accessible name; there is no other text the switch could borrow. */
export function switchControl(opts: {
  id: string;
  label: string;
  on?: boolean;
  name?: string;
  attrs?: string;
}): string {
  return `<button type="button" class="sw${opts.on ? " on" : ""}" id="${escapeHtml(
    opts.id,
  )}"${opts.name ? ` name="${escapeHtml(opts.name)}"` : ""} role="switch" aria-checked="${
    opts.on ? "true" : "false"
  }" aria-label="${escapeHtml(opts.label)}"${opts.attrs ? ` ${opts.attrs}` : ""}></button>`;
}

export function field(opts: {
  label: string;
  id: string;
  name?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  rows?: number;
  required?: boolean;
  autocomplete?: string;
  attrs?: string;
}): string {
  const base = `class="inp" id="${escapeHtml(opts.id)}"${
    opts.name ? ` name="${escapeHtml(opts.name)}"` : ""
  }${opts.required ? " required" : ""}${
    opts.autocomplete ? ` autocomplete="${escapeHtml(opts.autocomplete)}"` : ""
  }${opts.attrs ? ` ${opts.attrs}` : ""}`;
  const control =
    opts.type === "textarea"
      ? `<textarea ${base}${opts.rows ? ` rows="${opts.rows}"` : ""}>${escapeHtml(
          opts.value ?? "",
        )}</textarea>`
      : `<input ${base} type="${escapeHtml(
          opts.type ?? "text",
        )}" value="${escapeHtml(opts.value ?? "")}"${
          opts.placeholder
            ? ` placeholder="${escapeHtml(opts.placeholder)}"`
            : ""
        }>`;
  return `<div class="field">
  <label for="${escapeHtml(opts.id)}">${text(opts.label)}</label>
  ${control}
  ${opts.hint ? `<div class="help">${text(opts.hint)}</div>` : ""}
</div>`;
}

export function dl(items: { k: string; v: string }[]): string {
  return `<dl class="dl">${items
    .map((item) => `<div><dt>${text(item.k)}</dt><dd>${item.v}</dd></div>`)
    .join("")}</dl>`;
}

export function emptyState(opts: {
  title: string;
  text: string;
  icon?: string;
  action?: string;
}): string {
  return `<div class="empty">${
    opts.icon ? `<div class="eic">${icon(opts.icon)}</div>` : ""
  }<div class="t">${text(opts.title)}</div><p>${text(opts.text)}</p>${
    opts.action ? `<div class="a">${opts.action}</div>` : ""
  }</div>`;
}

const ALERT_ICON: Record<Tone, string> = {
  emerald: "circle-check",
  amber: "triangle-alert",
  red: "circle-alert",
  sky: "info",
  neutral: "info",
};

export function alert(
  tone: Tone,
  opts: { title?: string; body: string; icon?: string; action?: string },
): string {
  const mark = opts.icon ? icon(opts.icon) : icon(ALERT_ICON[tone]);
  return `<div class="alert ${TONE_CLASS[tone]}">${mark}<div>${
    opts.title ? `<div class="t">${text(opts.title)}</div>` : ""
  }<p>${opts.body}</p></div>${opts.action ?? ""}</div>`;
}

export function codeBlock(opts: { code: string; label?: string }): string {
  return `<div class="code">${
    opts.label ? `<span class="lbl">${text(opts.label)}</span>` : ""
  }<span>${escapeHtml(opts.code)}</span><button type="button" data-copy title="Copy">${icon(
    "copy",
  )}</button></div>`;
}

export function steps(
  items: {
    title: string;
    detail?: string;
    n?: number;
    state?: "done" | "now";
  }[],
): string {
  return `<div class="steps">${items
    .map((item) => {
      const state = item.state ?? "";
      const mark =
        item.state === "done" ? icon("check") : text(String(item.n ?? ""));
      return `<div class="step${state ? ` ${state}` : ""}">
  <div class="hdr"><span class="n">${mark}</span><div class="b"><div class="ttl">${text(
    item.title,
  )}</div>${
    item.detail ? `<p class="muted">${text(item.detail)}</p>` : ""
  }</div>${icon("chevron-right", "chev")}</div>
</div>`;
    })
    .join("")}</div>`;
}

export function timeline(
  items: { title: string; when?: string; body?: string; icon?: string }[],
): string {
  return `<ul class="timeline">${items
    .map(
      (item) =>
        `<li><span class="ic">${icon(item.icon ?? "circle")}</span><div><div class="strong">${text(
          item.title,
        )}</div>${
          item.when ? `<div class="sub">${text(item.when)}</div>` : ""
        }${item.body ? `<p class="muted">${item.body}</p>` : ""}</div></li>`,
    )
    .join("")}</ul>`;
}
