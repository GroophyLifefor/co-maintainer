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

function startInitJob(repo: string): Job {
  const job: Job = { repo, lines: [], done: false, subscribers: new Set() };
  currentJob = job;
  const push = (line: string) => {
    job.lines.push(line);
    for (const send of job.subscribers) send(line);
  };
  (async () => {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", Deno.mainModule, "init", repo],
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
      <button type="submit">Init</button>
    </form>
    <pre id="log"></pre>
  </div>
  <script>
    const log = document.getElementById('log');
    const form = document.getElementById('init-form');
    form.addEventListener('submit', () => {
      log.textContent = '';
      setTimeout(() => {
        const source = new EventSource('/dashboard/init/stream');
        source.onmessage = (event) => {
          if (event.data === '__close__') { source.close(); return; }
          log.textContent += event.data + '\\n';
          log.scrollTop = log.scrollHeight;
        };
      }, 300);
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
  input { width: 100%; box-sizing: border-box; padding: .4rem; font: inherit; margin-top: .2rem; }
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
    startInitJob(repo);
    return Response.redirect(`${url.origin}/dashboard`, 303);
  }

  if (url.pathname === "/dashboard/init/stream" && req.method === "GET") {
    if (!currentJob) return new Response("no job running", { status: 404 });
    const job = currentJob;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (line: string) =>
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        for (const line of job.lines) send(line);
        if (job.done) {
          send("__close__");
          controller.close();
          return;
        }
        const subscriber = (line: string) => {
          send(line);
          if (line === "__close__") controller.close();
        };
        job.subscribers.add(subscriber);
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
