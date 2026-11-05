import { test } from "node:test";
import {
  alert,
  badge,
  card,
  codeBlock,
  crumb,
  dl,
  emptyState,
  field,
  foot,
  icon,
  pageHeader,
  section,
  segmented,
  statCard,
  steps,
  switchControl,
  table,
  tabs,
  timeline,
  type Tone,
} from "./ui.ts";

function must(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

test("pageHeader links a crumb, title, lead and actions", () => {
  const html = pageHeader({
    title: "Reviews",
    lead: "Last 30 days.",
    crumb: crumb([{ label: "acme/widgets", href: "/repos/acme/widgets" }]),
    actions: `<button class="btn pri">Run</button>`,
  });
  must(html.includes("<h1>Reviews</h1>"), "missing h1");
  must(html.includes('<div class="d">Last 30 days.</div>'), "missing lead");
  must(html.includes('class="actions-row"'), "missing actions row");
  must(html.includes('href="/repos/acme/widgets"'), "crumb is not a link");
});

test("tabs mark the active tab and show a count", () => {
  const html = tabs([
    { label: "Overview", href: "/o", on: true },
    { label: "Pulls", href: "/p", count: 3 },
  ]);
  must(html.includes('<a href="/o" class="on">Overview</a>'), "active tab");
  must(html.includes('<span class="cnt">3</span>'), "count missing");
});

test("card adds flush and red modifiers", () => {
  const html = card(section("body", { title: "T" }), {
    flush: true,
    red: true,
  });
  must(html.startsWith('<div class="card flush red">'), html.slice(0, 40));
  must(html.includes('<div class="sec">'), "section missing");
});

test("section renders a header with count and action", () => {
  const html = section("x", {
    title: "Recent",
    count: 3,
    action: `<a href="#">All</a>`,
    lead: "desc",
  });
  must(html.includes('<h2>Recent<span class="cnt">3</span>'), "header");
  must(html.includes('<span class="act">'), "action slot");
  must(html.includes('<div class="lead">desc</div>'), "lead");
});

test("table renders head and rows, or an empty note", () => {
  const html = table({ head: ["A", "B"], rows: [["1", "2"]] });
  must(html.includes("<thead><tr><th>A</th><th>B</th></tr></thead>"), "head");
  must(html.includes("<tbody><tr><td>1</td><td>2</td></tr></tbody>"), "rows");
  const empty = table({ head: ["A"], rows: [], empty: "Nothing here" });
  must(empty.includes("Nothing here"), "empty note");
  must(!empty.includes("<table"), "empty state still printed a table");
});

test("badge maps every tone to its class", () => {
  const tones: Tone[] = ["emerald", "amber", "red", "sky", "neutral"];
  const classes = ["b-em", "b-am", "b-red", "b-sky", "b-ne"];
  tones.forEach((tone, i) => {
    const html = badge(tone, "Hi", { icon: "check" });
    must(html.includes(`badge ${classes[i]}`), `badge class for ${tone}`);
    must(html.includes('href="#i-check"'), `badge icon for ${tone}`);
    must(html.includes("Hi"), "badge label");
  });
});

test("statCard shows label, value, hint and icon", () => {
  const html = statCard({
    label: "Cost",
    value: "$4.20",
    hint: "30 days",
    icon: "coins",
  });
  must(html.includes("Cost"), "label");
  must(html.includes('<div class="v">$4.20</div>'), "value");
  must(html.includes('<div class="h">30 days</div>'), "hint");
  must(html.includes('href="#i-coins"'), "icon");
});

test("segmented marks the active item and a recommended tag", () => {
  const html = segmented([
    { label: "30d", on: true },
    { label: "Recommended", tag: "rec", tagRec: true },
  ]);
  must(
    html.includes('<button type="button" class="on">30d</button>'),
    "active",
  );
  must(html.includes('<span class="tag rec">rec</span>'), "tag");
});

test("switchControl is an accessible switch", () => {
  const html = switchControl({ id: "auto", label: "Auto review", on: true });
  must(html.includes('role="switch"'), "role");
  must(html.includes('aria-checked="true"'), "checked state");
  must(html.includes('aria-label="Auto review"'), "accessible name");
  must(html.includes('id="auto"'), "id");
  must(html.includes('class="sw on"'), "on class");
});

test("field always links its label and control", () => {
  const text = field({
    label: "Repository",
    id: "repo",
    value: "acme/widgets",
  });
  must(text.includes('<label for="repo">Repository</label>'), "label for");
  must(text.includes('id="repo"'), "control id");
  must(text.includes('value="acme/widgets"'), "value");
  const area = field({
    label: "Guide",
    id: "guide",
    type: "textarea",
    rows: 4,
  });
  must(area.includes("<textarea"), "textarea control");
  must(area.includes('rows="4"'), "rows");
  must(area.includes('<label for="guide">'), "textarea label");
  const hint = field({ label: "Branch", id: "b", hint: "Defaults to main" });
  must(hint.includes('<div class="help">Defaults to main</div>'), "hint");
});

test("field escapes values instead of injecting them", () => {
  const html = field({ label: "X", id: "x", value: '"><img src=x>' });
  must(!html.includes("<img"), "the value was injected");
  must(html.includes("&quot;&gt;&lt;img src=x&gt;"), html);
});

test("dl renders pairs", () => {
  const html = dl([{ k: "Provider", v: "OpenRouter" }]);
  must(html.includes("<dt>Provider</dt><dd>OpenRouter</dd>"), html);
});

test("emptyState renders an icon, title, text and action", () => {
  const html = emptyState({
    title: "No reviews yet",
    text: "Start one by number.",
    icon: "inbox",
    action: `<button class="btn pri">Start</button>`,
  });
  must(html.includes('href="#i-inbox"'), "icon");
  must(html.includes('<div class="t">No reviews yet</div>'), "title");
  must(html.includes("Start one by number."), "text");
  must(html.includes('class="a"'), "action");
});

test("alert carries its tone, default icon and title", () => {
  const html = alert("amber", { title: "Setup", body: "Not finished." });
  must(html.includes('class="alert b-am"'), "tone class");
  must(html.includes('href="#i-triangle-alert"'), "default icon");
  must(html.includes('<div class="t">Setup</div>'), "title");
  must(html.includes("<p>Not finished.</p>"), "body");
});

test("codeBlock is copyable and escapes its code", () => {
  const html = codeBlock({ code: 'co-maintainer init "acme/widgets"' });
  must(html.includes('<div class="code">'), "wrapper");
  must(html.includes("data-copy"), "copy button");
  must(html.includes('href="#i-copy"'), "copy icon");
  must(html.includes("&quot;acme/widgets&quot;"), "code not escaped");
});

test("steps mark done and current steps", () => {
  const html = steps([
    { title: "One", n: 1, state: "done" },
    { title: "Two", n: 2, state: "now" },
  ]);
  must(html.includes('class="step done"'), "done step");
  must(html.includes('class="step now"'), "current step");
  must(html.includes('href="#i-check"'), "a done step shows a check");
});

test("timeline renders items with a marker icon", () => {
  const html = timeline([
    { title: "Review posted", when: "2m", icon: "circle-check" },
  ]);
  must(html.includes('<ul class="timeline">'), "list");
  must(html.includes('href="#i-circle-check"'), "marker");
  must(html.includes('<div class="sub">2m</div>'), "when");
});

test("foot separates its content", () => {
  must(foot('<span class="sp"></span>').includes('class="foot"'), "foot");
});

test("no component hard-codes a max-width or an em dash", () => {
  const outputs = [
    pageHeader({ title: "T" }),
    card("x"),
    section("x", { title: "H" }),
    foot("x"),
    table({ head: ["A"], rows: [["1"]] }),
    badge("red", "x"),
    statCard({ label: "L", value: "1" }),
    segmented([{ label: "a" }]),
    switchControl({ id: "i", label: "l" }),
    field({ label: "l", id: "i" }),
    dl([{ k: "k", v: "v" }]),
    emptyState({ title: "t", text: "x" }),
    alert("sky", { body: "b" }),
    codeBlock({ code: "c" }),
    steps([{ title: "t", n: 1 }]),
    timeline([{ title: "t" }]),
    icon("check"),
  ].join("");
  must(!outputs.includes('style="max-width'), "an inline max-width leaked");
  must(!outputs.includes("\u2014"), "an em dash leaked");
});
