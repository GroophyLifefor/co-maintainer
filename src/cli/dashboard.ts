import { readConfig, writeUserConfig } from "../config.ts";
import type { UserConfig } from "../config.ts";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        char
      ] ?? char),
  );
}

type Job = {
  repo: string;
  lines: string[];
  done: boolean;
  ok?: boolean;
  subscribers: Set<(line: string) => void>;
};

let currentJob: Job | undefined;

function startInitJob(repo: string, extraArgs: string[]): Job {
  const job: Job = { repo, lines: [], done: false, subscribers: new Set() };
  currentJob = job;
  const push = (line: string) => {
    job.lines.push(line);
    for (const send of job.subscribers) send(line);
  };
  (async () => {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", Deno.mainModule, "init", repo, ...extraArgs],
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    const readLines = async (
      readable: ReadableStream<Uint8Array>,
      prefix: string,
    ) => {
      const reader = readable.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) push(`${prefix}${part}`);
      }
      if (buffer) push(`${prefix}${buffer}`);
    };
    await Promise.all([
      readLines(child.stdout, ""),
      readLines(child.stderr, ""),
    ]);
    const status = await child.status;
    job.ok = status.success;
    job.done = true;
    push(status.success ? "[dashboard] init finished" : "[dashboard] init failed");
    for (const send of job.subscribers) send("__close__");
    job.subscribers.clear();
  })();
  return job;
}

function renderConfigForm(config: UserConfig): string {
  const field = (label: string, name: string, value: unknown, secret = false) => `
    <label>${escapeHtml(label)}
      <input name="${name}" type="${secret ? "password" : "text"}"
        placeholder="${secret && value ? "•••• (unchanged if left blank)" : ""}"
        value="${secret ? "" : escapeHtml(value ?? "")}">
    </label>`;
  return `
  <form method="post" action="/dashboard/config" class="card">
    <h2>Global configuration</h2>
    ${field("Auth (gh|pat)", "auth", config.auth)}
    ${field("AI provider (none|openrouter|hetzner)", "ai", config.ai)}
    ${field("Low model", "low-model", config.lowModel)}
    ${field("High model", "high-model", config.highModel)}
    ${field("API token", "token", config.token, true)}
    ${field("GitHub App ID", "github-app-id", config.githubAppId)}
    ${field("GitHub App private key", "github-app-private-key", config.githubAppPrivateKey, true)}
    ${field("GitHub webhook secret", "github-webhook-secret", config.githubWebhookSecret, true)}
    <button type="submit">Save</button>
  </form>`;
}

function renderRepos(config: UserConfig): string {
  const repos = Object.entries(config.repos ?? {});
  const rows = repos.map(([repo, r]) =>
    `<tr>
      <td>${escapeHtml(repo)}</td>
      <td>${escapeHtml(r.ai ?? "")}</td>
      <td>${escapeHtml(r.highModel ?? "")}</td>
      <td><button type="submit" name="repo" value="${escapeHtml(repo)}" form="init-form">Re-init</button></td>
    </tr>`
  ).join("\n");
  return `
  <div class="card">
    <h2>Repositories</h2>
    <table>
      <thead><tr><th>repo</th><th>ai</th><th>high model</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">none yet</td></tr>'}</tbody>
    </table>
    <form id="init-form" method="post" action="/dashboard/init">
      <input name="repo" placeholder="owner/repo" required>
      <details>
        <summary>Parameters</summary>
        <label>AI provider <select name="ai">
          <option value="">(use default)</option>
          <option value="none">none</option>
          <option value="openrouter">openrouter</option>
          <option value="hetzner">hetzner</option>
        </select></label>
        <label>Auth <select name="auth">
          <option value="">(use default)</option>
          <option value="gh">gh</option>
          <option value="pat">pat</option>
        </select></label>
        <label>Low model <input name="low-model" placeholder="(use default)"></label>
        <label>High model <input name="high-model" placeholder="(use default)"></label>
        <label>Max PR months <input name="max-pr-months" type="number" min="0" placeholder="(no limit)"></label>
        <label>Max commits <input name="max-commits" type="number" min="0" placeholder="(no limit)"></label>
        <label>Max PR change lines <input name="max-pull-request-change-lines" type="number" min="0" placeholder="(no limit)"></label>
        <label>Max comments per PR <input name="max-comment" type="number" min="0" placeholder="(no limit)"></label>
        <label>GitHub fetch concurrency <input name="gh-concurrent" type="number" min="1" placeholder="1"></label>
        <label>AI job concurrency <input name="ai-concurrent" type="number" min="1" placeholder="3"></label>
        <label><input type="checkbox" name="customize-sources"> Customize included sources</label>
        <fieldset id="sources" disabled>
          <label><input type="checkbox" name="include-codebase" checked> codebase</label>
          <label><input type="checkbox" name="include-pull-requests" checked> pull requests</label>
          <label><input type="checkbox" name="include-pull-request-changes" checked> pull request changes</label>
          <label><input type="checkbox" name="include-commit-history" checked> commit history</label>
          <label><input type="checkbox" name="include-how-repo-works" checked> how repo works</label>
        </fieldset>
      </details>
      <button type="submit">Init</button>
    </form>
    <pre id="log"></pre>
  </div>
  <script>
    document.querySelector('[name=customize-sources]').addEventListener('change', (e) => {
      document.getElementById('sources').disabled = !e.target.checked;
    });
    const log = document.getElementById('log');
    const form = document.getElementById('init-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      log.textContent = '';
      const response = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
      });
      if (!response.ok) {
        log.textContent = await response.text();
        return;
      }
      const source = new EventSource('/dashboard/init/stream');
      source.onmessage = (msgEvent) => {
        if (msgEvent.data === '__close__') { source.close(); return; }
        log.textContent += msgEvent.data + '\\n';
        log.scrollTop = log.scrollHeight;
      };
      source.onerror = () => source.close();
    });
  </script>`;
}

function page(body: string): string {
  return `<!doctype html>
<title>co-maintainer dashboard</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.2rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  label { display: block; margin: .5rem 0; font-size: .85rem; color: #555; }
  input, select { width: 100%; box-sizing: border-box; padding: .4rem; font: inherit; margin-top: .2rem; }
  fieldset { border: 1px solid #eee; border-radius: 6px; margin: .5rem 0; }
  fieldset[disabled] { opacity: .5; }
  fieldset label, details > label { display: flex; align-items: center; gap: .4rem; }
  fieldset input, details > label input[type=checkbox] { width: auto; }
  details summary { cursor: pointer; margin: .5rem 0; color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .3rem .4rem; border-bottom: 1px solid #eee; font-size: .9rem; }
  button { padding: .4rem .8rem; margin-top: .5rem; cursor: pointer; }
  pre#log { background: #111; color: #ddd; padding: .75rem; border-radius: 6px; max-height: 300px; overflow: auto; white-space: pre-wrap; }
</style>
<h1>co-maintainer</h1>
${body}`;
}

export async function handleDashboardRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/dashboard" && req.method === "GET") {
    const config = readConfig();
    return new Response(page(renderRepos(config) + renderConfigForm(config)), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/dashboard/config" && req.method === "POST") {
    const form = await req.formData();
    const patch: Record<string, unknown> = {};
    const fields: [string, string][] = [
      ["auth", "auth"],
      ["ai", "ai"],
      ["low-model", "lowModel"],
      ["high-model", "highModel"],
      ["token", "token"],
      ["github-app-id", "githubAppId"],
      ["github-app-private-key", "githubAppPrivateKey"],
      ["github-webhook-secret", "githubWebhookSecret"],
    ];
    for (const [formName, field] of fields) {
      const value = form.get(formName);
      if (typeof value === "string" && value !== "") patch[field] = value;
    }
    await writeUserConfig(patch);
    return Response.redirect(`${url.origin}/dashboard`, 303);
  }

  if (url.pathname === "/dashboard/init" && req.method === "POST") {
    const form = await req.formData();
    const repo = String(form.get("repo") ?? "");
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      return new Response("repo must look like owner/repo", { status: 400 });
    }
    if (currentJob && !currentJob.done) {
      return new Response(
        `already running an init for ${currentJob.repo}`,
        { status: 409 },
      );
    }
    const extraArgs: string[] = [];
    const textFields = [
      "ai",
      "auth",
      "low-model",
      "high-model",
      "max-pr-months",
      "max-commits",
      "max-pull-request-change-lines",
      "max-comment",
      "gh-concurrent",
      "ai-concurrent",
    ];
    for (const name of textFields) {
      const value = form.get(name);
      if (typeof value === "string" && value !== "") {
        extraArgs.push(`--${name}=${value}`);
      }
    }
    if (form.get("customize-sources")) {
      for (
        const name of [
          "include-codebase",
          "include-pull-requests",
          "include-pull-request-changes",
          "include-commit-history",
          "include-how-repo-works",
        ]
      ) {
        if (form.get(name)) extraArgs.push(`--${name}`);
      }
    }
    startInitJob(repo, extraArgs);
    return new Response("started", { status: 200 });
  }

  if (url.pathname === "/dashboard/init/stream" && req.method === "GET") {
    if (!currentJob) return new Response("no job running", { status: 404 });
    const job = currentJob;
    let subscriber: ((line: string) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (line: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${line}\n\n`));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          if (subscriber) job.subscribers.delete(subscriber);
          try {
            controller.close();
          } catch {
            // already closed by the client disconnecting
          }
        };
        for (const line of job.lines) send(line);
        if (job.done) {
          send("__close__");
          close();
          return;
        }
        subscriber = (line: string) => {
          send(line);
          if (line === "__close__") close();
        };
        job.subscribers.add(subscriber);
      },
      cancel() {
        // The client disconnected (closed the tab, called source.close(),
        // or the connection dropped) — stop pushing to it.
        if (subscriber) job.subscribers.delete(subscriber);
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  return new Response("not found", { status: 404 });
}
