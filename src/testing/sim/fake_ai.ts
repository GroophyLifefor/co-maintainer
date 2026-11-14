/** What the fake AI answers when `e2e:simulate` runs without `--ai`.
 *
 * The product talks to a real provider client (OpenRouter's), and the caught
 * fetch hands each chat request here. Each flow scripts the answers: a rule
 * matches a call by the job name the product gave it, by text in its prompt,
 * or both, and says what the model answers. A call no rule matches is
 * answered with an error and marked unscripted, which fails a check, so a new
 * AI call can never slip through on an empty answer.
 *
 * A score computed on these answers measures nothing about a model, and the
 * report marks it as fake. */
import { promptOf } from "../fake_openrouter.ts";

type Json = Record<string, unknown>;

/** What the model answers one call with. */
export type AiReply =
  /** Plain text. */
  | string
  | { text: string }
  /** A review answer: `{"findings":[...]}`. */
  | { findings: unknown[] }
  /** Any JSON value, as the answer's text. */
  | { json: unknown }
  /** The model asks for tools. The product runs them and calls again with
   * the results, which is the next round. */
  | { toolCalls: { name: string; arguments?: unknown }[]; text?: string }
  /** The connection closes after part of the answer arrived. */
  | { cutOff: string }
  /** The model stopped at its output limit (`finish_reason: length`). */
  | { outputLimit: string }
  /** The provider answers with this HTTP status. */
  | { error: number; message?: string };

/** One AI call, as a rule sees it. */
export type AiCall = {
  /** The job name the product gave the call, e.g. `review_pull_request`. */
  job?: string;
  /** System and user messages joined. */
  prompt: string;
  /** Tool results already in the conversation: 0 on the first round. */
  round: number;
  body: Json;
};

export type AiRule = {
  /** Shown in the trace next to each call it answered. */
  name?: string;
  /** Matches the job name: a string must be equal, a RegExp must match. */
  job?: string | RegExp;
  /** Matches the prompt: a string must appear in it, a RegExp must match. */
  prompt?: string | RegExp;
  /** One reply answers every matching call. A list answers one call each, in
   * order, and the rule stops matching when it runs out. A function decides
   * per call. */
  reply: AiReply | AiReply[] | ((call: AiCall) => AiReply);
  /** How many calls the rule answers. Unlimited by default. */
  times?: number;
  /** The flow may never reach this rule. Without it, a rule that answered
   * nothing fails the "every AI rule answered" check. */
  optional?: boolean;
};

export type FakeAnswer = {
  status: number;
  body: unknown;
  /** Set when the connection must close after this much of the body. */
  cutOff?: string;
  /** The rule that answered, or undefined when none did. */
  rule?: string;
};

function jobMatches(pattern: string | RegExp | undefined, value?: string) {
  if (pattern === undefined) return true;
  if (value === undefined) return false;
  return typeof pattern === "string" ? value === pattern : pattern.test(value);
}

/** Token counts are the prompt and answer length over four, so they move when
 * a prompt grows. Cost is zero. */
function completion(
  body: Json,
  prompt: string,
  content: string,
  extra: { finish?: string; toolCalls?: Json[] } = {},
): Json {
  return {
    id: "simulate",
    model: String(body.model ?? "fake"),
    choices: [
      {
        finish_reason: extra.finish ?? "stop",
        message: {
          role: "assistant",
          content,
          ...(extra.toolCalls ? { tool_calls: extra.toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: Math.ceil(
        (content.length + JSON.stringify(extra.toolCalls ?? "").length) / 4,
      ),
      cost: 0,
    },
  };
}

export class FakeAi {
  private readonly rules: { rule: AiRule; used: number }[] = [];
  private nextToolCall = 1;

  /** Adds rules ahead of the ones already there, so a rule added in the
   * middle of a flow wins over the flow's script. Within one call the first
   * rule listed wins, so list the specific ones first. */
  use(...rules: AiRule[]): void {
    this.rules.unshift(...rules.map((rule) => ({ rule, used: 0 })));
  }

  /** Rules that never answered a call, `optional` ones left out. */
  unused(): AiRule[] {
    return this.rules
      .filter((entry) => entry.used === 0 && !entry.rule.optional)
      .map((entry) => entry.rule);
  }

  private replyFor(
    entry: { rule: AiRule; used: number },
    call: AiCall,
  ): AiReply | undefined {
    const { reply } = entry.rule;
    if (typeof reply === "function") return reply(call);
    if (Array.isArray(reply)) return reply[entry.used];
    return reply;
  }

  /** The answer to one chat request. */
  answer(body: Json, job: string | undefined): FakeAnswer {
    const prompt = promptOf(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const call: AiCall = {
      job,
      prompt,
      round: messages.filter((message) => (message as Json)?.role === "tool")
        .length,
      body,
    };
    for (const entry of this.rules) {
      const { rule } = entry;
      if (rule.times !== undefined && entry.used >= rule.times) continue;
      if (Array.isArray(rule.reply) && entry.used >= rule.reply.length) {
        continue;
      }
      if (!jobMatches(rule.job, job) || !textMatches(rule.prompt, prompt)) {
        continue;
      }
      const reply = this.replyFor(entry, call);
      if (reply === undefined) continue;
      entry.used++;
      return { ...this.render(body, prompt, reply), rule: rule.name ?? "" };
    }
    return {
      status: 500,
      body: {
        error: {
          message: `e2e:simulate: no fake AI rule answers job ${job ?? "(unknown)"}`,
        },
      },
    };
  }

  private render(body: Json, prompt: string, reply: AiReply): FakeAnswer {
    if (typeof reply === "string") {
      return { status: 200, body: completion(body, prompt, reply) };
    }
    if ("text" in reply && !("toolCalls" in reply)) {
      return { status: 200, body: completion(body, prompt, reply.text) };
    }
    if ("findings" in reply) {
      const text = JSON.stringify({ findings: reply.findings });
      return { status: 200, body: completion(body, prompt, text) };
    }
    if ("json" in reply) {
      const text = JSON.stringify(reply.json);
      return { status: 200, body: completion(body, prompt, text) };
    }
    if ("toolCalls" in reply) {
      const toolCalls = reply.toolCalls.map((call) => ({
        id: `call_${this.nextToolCall++}`,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      }));
      return {
        status: 200,
        body: completion(body, prompt, reply.text ?? "", {
          finish: "tool_calls",
          toolCalls,
        }),
      };
    }
    if ("cutOff" in reply) {
      return {
        status: 200,
        body: completion(body, prompt, reply.cutOff),
        cutOff: reply.cutOff,
      };
    }
    if ("outputLimit" in reply) {
      return {
        status: 200,
        body: completion(body, prompt, reply.outputLimit, { finish: "length" }),
      };
    }
    return {
      status: reply.error,
      body: { error: { message: reply.message ?? `HTTP ${reply.error}` } },
    };
  }
}

function textMatches(pattern: string | RegExp | undefined, value: string) {
  if (pattern === undefined) return true;
  return typeof pattern === "string"
    ? value.includes(pattern)
    : pattern.test(value);
}

/** A finding as the review JSON carries it, with the fields a check usually
 * does not care about filled in. */
export function finding(input: {
  path: string;
  line: number;
  title: string;
  body?: string;
  severity?: "P0" | "P1" | "P2" | "P3";
  blocking?: boolean;
  suggestion?: string;
}): Json {
  return {
    severity: input.severity ?? "P2",
    blocking: input.blocking ?? false,
    path: input.path,
    lineFrom: input.line,
    lineTo: input.line,
    title: input.title,
    body: input.body ?? `${input.title}.`,
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
  };
}
