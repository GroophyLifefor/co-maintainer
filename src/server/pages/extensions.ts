/** One review's extensions on the dashboard: each result with its fail or
 * skip reason, its media, metrics and findings, and its `markdown`, which the
 * dashboard always keeps even when the GitHub review dropped it for length.
 * Management stays in the CLI. */
import { markdown, text } from "./layout.ts";
import { locationOf } from "../../extensions/render_cli.ts";
import {
  effectiveBlocking,
  extensionsCostUsd,
  type ExtensionReport,
} from "../../extensions/report.ts";

function outcome(result: ExtensionReport["results"][number]): string {
  if (result.status === "ok") return result.verdict ?? "ok";
  return result.status;
}

/** Only http and https links are drawn as links, the same rule the schema
 * enforces, so a stored row from anywhere else cannot become a script link. */
function safeLink(url: string, label: string): string {
  return /^https?:\/\//i.test(url)
    ? `<a href="${text(url)}" rel="noopener noreferrer" target="_blank">${text(label)}</a>`
    : text(label);
}

/** Under a review's total: the part the extensions cost. The review's own
 * cost is the total minus this. */
export function extensionCostNote(report: ExtensionReport): string {
  const cost = extensionsCostUsd(report);
  return cost > 0
    ? `<div class="muted" style="font-size:12px">incl. $${cost.toFixed(4)} extensions</div>`
    : "";
}

export function renderExtensionResults(report: ExtensionReport): string {
  if (report.results.length === 0) return "";
  const blocks = report.results.map((result) => {
    const findings = report.findings.filter(
      (row) => row.extensionId === result.name,
    );
    const head = `<div style="margin-bottom:6px"><b>${text(result.name)}</b>
      <span class="muted"> · ${text(outcome(result))}${
        result.usage?.costUsd !== undefined
          ? ` · $${result.usage.costUsd.toFixed(4)}`
          : ""
      }</span></div>`;
    const reason = result.reason
      ? `<div class="muted" style="font-size:13px;margin-bottom:8px">${text(result.reason)}</div>`
      : "";
    const media = result.data.media.length
      ? `<div style="font-size:13px;margin-bottom:8px">${result.data.media
          .map((item) => `${text(item.kind)} ${safeLink(item.url, item.label)}`)
          .join(" · ")}</div>`
      : "";
    const metrics = result.data.metrics.length
      ? `<div class="muted" style="font-size:13px;margin-bottom:8px">${result.data.metrics
          .map(
            (metric) =>
              `${text(metric.name)}: ${text(metric.value)}${metric.unit ? ` ${text(metric.unit)}` : ""}`,
          )
          .join(" · ")}</div>`
      : "";
    const list = findings.length
      ? `<ul style="margin:0 0 8px 18px;padding:0">${findings
          .map((row) => {
            const where = locationOf(row);
            return `<li><span class="mono" style="font-size:12px">[${text(row.severity)} · ${
              effectiveBlocking(report, row) ? "blocking" : "non-blocking"
            }]</span> ${text(row.title)}${
              where
                ? ` <span class="mono muted" style="font-size:12px">${text(where)}</span>`
                : ""
            } <span class="muted" style="font-size:12px">${text(
              row.state === "open" ? "still open" : row.state,
            )}</span></li>`;
          })
          .join("")}</ul>`
      : "";
    const body = result.markdown.trim() ? markdown(result.markdown) : "";
    const details = result.details
      ? `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:13px">Output</summary>
          <pre class="mono" style="white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto">${text(result.details)}</pre></details>`
      : "";
    return `<div style="padding:10px 0;border-top:1px solid var(--border2)">${head}${reason}${media}${metrics}${list}${body}${details}</div>`;
  });
  const cost = extensionsCostUsd(report);
  return `<div style="margin-top:12px">
    <div class="muted" style="font-size:13px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">Extensions${
      cost > 0 ? ` · $${cost.toFixed(4)}` : ""
    }</div>
    ${blocks.join("")}
  </div>`;
}
