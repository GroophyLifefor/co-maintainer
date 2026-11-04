import { escapeHtml, text, when } from "./layout.ts";
import type {
  RateLimitWait,
  RateLimitWaitSummary,
} from "../../services/rate_limit.ts";

const SERVICE_LABEL: Record<string, string> = {
  openrouter: "OpenRouter",
  github: "GitHub",
};

export function rateLimitServiceLabel(service: string): string {
  return SERVICE_LABEL[service] ?? service;
}

function secondsLabel(seconds: number): string {
  return `${seconds} s`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

type WaitGroup = {
  service: string;
  waits: RateLimitWait[];
  durations: number[];
};

function groupWaits(waits: RateLimitWait[]): WaitGroup[] {
  const byService = new Map<string, RateLimitWait[]>();
  for (const wait of waits) {
    const list = byService.get(wait.service) ?? [];
    list.push(wait);
    byService.set(wait.service, list);
  }
  return [...byService.entries()].map(([service, list]) => ({
    service,
    waits: list,
    durations: [...new Set(list.map((wait) => wait.seconds))].sort(
      (a, b) => a - b,
    ),
  }));
}

function groupSentence(group: WaitGroup): string {
  const label = rateLimitServiceLabel(group.service);
  const count = group.waits.length;
  const times = count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
  if (group.durations.length === 1) {
    const each = count === 1 ? "" : " each time";
    return `${label} asked to slow down ${times}; waited ${secondsLabel(group.durations[0]!)}${each}`;
  }
  return `${label} asked to slow down ${times}; waited ${joinList(group.durations.map(secondsLabel))}`;
}

export function rateLimitWaitSummaryLine(
  summary: RateLimitWaitSummary,
): string {
  const waits = `${summary.count} wait${summary.count === 1 ? "" : "s"}`;
  return `${waits}, ${summary.totalSeconds} s total`;
}

export function rateLimitWaitNotice(
  waits: RateLimitWait[],
  summary: RateLimitWaitSummary,
  title: string,
): string {
  if (waits.length === 0) return "";
  const sentences = groupWaits(waits).map(groupSentence).join(" ");
  return `<div class="notice warn" data-rate-limit-waits>
    <div class="txt"><b>${text(title)}</b>
      <div>${escapeHtml(sentences)}</div>
      <div class="muted">${text(rateLimitWaitSummaryLine(summary))}</div>
    </div>
  </div>`;
}

export function rateLimitWaitDetails(waits: RateLimitWait[]): string {
  if (waits.length === 0) return "";
  const rows = waits
    .map(
      (wait) => `<tr>
      <td>${text(rateLimitServiceLabel(wait.service))}</td>
      <td>${text(wait.stage)}</td>
      <td class="muted">${text(wait.reason)}</td>
      <td class="num">${text(secondsLabel(wait.seconds))}</td>
      <td class="muted">${when(wait.at)}</td>
    </tr>`,
    )
    .join("");
  return `<div class="card"><div class="hd"><h2>Waits in this job</h2></div>
    <div class="bd flush"><table>
      <thead><tr><th>Service</th><th>Stage</th><th>Reason</th><th class="num">Waited</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>`;
}
