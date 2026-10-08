/** The review policy engine.
 *
 * A policy is an ordered list of rules. The first rule whose conditions all
 * hold decides what happens to a pull request, and when none holds the policy's
 * default action does. This file is pure: no database, no GitHub, no clock, so
 * every branch of it is a table test. `webhook.ts` gathers the facts and acts on
 * the answer. */

export const ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE",
] as const;
export type Association = (typeof ASSOCIATIONS)[number];

export const ACTIONS = ["review", "on-request", "skip"] as const;
export type PolicyAction = (typeof ACTIONS)[number];

export type RuleWhen = {
  association?: Association[];
  fork?: boolean;
  draft?: boolean;
  bot?: boolean;
  /** The pull request has at least one of these labels. */
  labels?: string[];
  targetBranch?: string[];
  changedLines?: { min?: number; max?: number };
};

export type PolicyRule = {
  name?: string;
  when: RuleWhen;
  action: PolicyAction;
  /** A fixed skip reason. Only the rules derived from the old per repository
   * switches set it, so their skips read exactly as they always did. */
  reason?: string;
};

export type ReviewPolicy = {
  rules: PolicyRule[];
  default: PolicyAction;
  defaultReason?: string;
  requestLabel: string;
  requestCommand: string;
  requesters: Association[];
  /** `head`: a request covers the commit it was made on. `pull-request`: the
   * first request covers every later push. */
  approvalScope: "head" | "pull-request";
  /** Reviews a pull request may get from the webhook. Unset means no limit. */
  maxRounds?: number;
};

export type PolicyInput = Partial<ReviewPolicy>;

/** What is known about a pull request. A fact GitHub did not send is left out,
 * and a rule that asks about it does not match. */
export type PolicyFacts = {
  association?: string;
  fork?: boolean;
  draft: boolean;
  bot: boolean;
  labels?: string[];
  targetBranch?: string;
  changedLines?: number;
};

export type PolicyDecision = {
  action: PolicyAction;
  /** 1 based position of the rule that decided, `null` for the default. */
  rule: number | null;
  reason: string;
};

const TRUSTED: Association[] = ["OWNER", "MEMBER", "COLLABORATOR"];

export const DEFAULT_POLICY_SETTINGS = {
  requestLabel: "co-maintainer:review",
  requestCommand: "/co-maintainer review",
  requesters: TRUSTED,
  approvalScope: "head",
} as const;

const SKIP_DRAFTS: PolicyRule = {
  name: "draft",
  when: { draft: true },
  action: "skip",
};
const SKIP_BOTS: PolicyRule = {
  name: "bot author",
  when: { bot: true },
  action: "skip",
};

export const TEMPLATES: Record<string, PolicyInput> = {
  everyone: { rules: [SKIP_DRAFTS, SKIP_BOTS], default: "review" },
  "trusted-auto": {
    rules: [
      SKIP_DRAFTS,
      SKIP_BOTS,
      {
        name: "trusted author",
        when: { association: TRUSTED },
        action: "review",
      },
    ],
    default: "on-request",
  },
  "on-request-only": { rules: [], default: "on-request" },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

export function withDefaults(input: PolicyInput): ReviewPolicy {
  return {
    rules: [],
    default: "review",
    ...DEFAULT_POLICY_SETTINGS,
    ...input,
  } as ReviewPolicy;
}

/** The policy the three old per repository switches amount to, so a repository
 * nobody has given a policy keeps behaving exactly as before. Switched off
 * means everything is skipped, and the drafts and bots switches only matter
 * while it is on. */
export function legacyPolicy(settings: {
  auto_review: number;
  skip_drafts: number;
  skip_bots: number;
}): ReviewPolicy {
  if (settings.auto_review !== 1) {
    return withDefaults({
      rules: [],
      default: "skip",
      defaultReason: "auto-review-off",
    });
  }
  const rules: PolicyRule[] = [];
  if (settings.skip_drafts === 1) {
    rules.push({ ...SKIP_DRAFTS, reason: "draft" });
  }
  if (settings.skip_bots === 1) {
    rules.push({ ...SKIP_BOTS, reason: "bot-author" });
  }
  return withDefaults({ rules, default: "review" });
}

function whenHolds(when: RuleWhen, facts: PolicyFacts): boolean {
  if (when.association) {
    if (
      facts.association === undefined ||
      !(when.association as string[]).includes(facts.association)
    ) {
      return false;
    }
  }
  if (when.fork !== undefined && facts.fork !== when.fork) return false;
  if (when.draft !== undefined && facts.draft !== when.draft) return false;
  if (when.bot !== undefined && facts.bot !== when.bot) return false;
  if (when.labels) {
    const have = new Set((facts.labels ?? []).map((l) => l.toLowerCase()));
    if (!when.labels.some((label) => have.has(label.toLowerCase()))) {
      return false;
    }
  }
  if (when.targetBranch) {
    if (
      facts.targetBranch === undefined ||
      !when.targetBranch.includes(facts.targetBranch)
    ) {
      return false;
    }
  }
  if (when.changedLines) {
    const lines = facts.changedLines;
    if (lines === undefined) return false;
    const { min, max } = when.changedLines;
    if (min !== undefined && lines < min) return false;
    if (max !== undefined && lines > max) return false;
  }
  return true;
}

const OUTCOME_TEXT: Record<PolicyAction, string> = {
  skip: "skipped by policy.",
  "on-request": "waiting for a maintainer request.",
  review: "reviewing.",
};

export function evaluatePolicy(
  policy: ReviewPolicy,
  facts: PolicyFacts,
): PolicyDecision {
  for (let index = 0; index < policy.rules.length; index++) {
    const rule = policy.rules[index]!;
    if (!whenHolds(rule.when, facts)) continue;
    const label = `Rule ${index + 1}${rule.name ? ` (${rule.name})` : ""}`;
    return {
      action: rule.action,
      rule: index + 1,
      reason: rule.reason ?? `${label}: ${OUTCOME_TEXT[rule.action]}`,
    };
  }
  return {
    action: policy.default,
    rule: null,
    reason:
      policy.defaultReason ?? `Default rule: ${OUTCOME_TEXT[policy.default]}`,
  };
}

/** Whether a pull request that a policy leaves waiting for a request may be
 * reviewed without a new one. Only the `pull-request` scope carries an earlier
 * request forward, and only once something was actually reviewed or queued. */
export function carriesEarlierRequest(
  policy: ReviewPolicy,
  hasEarlierReview: boolean,
): boolean {
  return policy.approvalScope === "pull-request" && hasEarlierReview;
}

/** Whether `body` starts with the request command as a whole word. */
export function isRequestCommand(body: string, command: string): boolean {
  const text = body.trim().toLowerCase();
  const wanted = command.trim().toLowerCase();
  if (!wanted || !text.startsWith(wanted)) return false;
  const next = text.charAt(wanted.length);
  return next === "" || /\s/.test(next);
}

type Check<T> = { ok: true; value: T } | { ok: false; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, path: string): Check<string[]> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { ok: false, problem: `${path} must be a list of strings` };
  }
  return { ok: true, value: value as string[] };
}

function associations(value: unknown, path: string): Check<Association[]> {
  const list = stringList(value, path);
  if (!list.ok) return list;
  const bad = list.value.find(
    (item) => !(ASSOCIATIONS as readonly string[]).includes(item),
  );
  if (bad !== undefined) {
    return {
      ok: false,
      problem: `${path} has "${bad}", expected one of ${ASSOCIATIONS.join(", ")}`,
    };
  }
  return { ok: true, value: list.value as Association[] };
}

function unknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string | undefined {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra === undefined ? undefined : `${path}: unknown field "${extra}"`;
}

function parseWhen(value: unknown, path: string): Check<RuleWhen> {
  if (!isRecord(value))
    return { ok: false, problem: `${path} must be an object` };
  const extra = unknownKey(
    value,
    [
      "association",
      "fork",
      "draft",
      "bot",
      "labels",
      "targetBranch",
      "changedLines",
    ],
    path,
  );
  if (extra) return { ok: false, problem: extra };
  const when: RuleWhen = {};
  if (value.association !== undefined) {
    const parsed = associations(value.association, `${path}.association`);
    if (!parsed.ok) return parsed;
    when.association = parsed.value;
  }
  for (const key of ["fork", "draft", "bot"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") {
      return { ok: false, problem: `${path}.${key} must be true or false` };
    }
    when[key] = value[key];
  }
  for (const key of ["labels", "targetBranch"] as const) {
    if (value[key] === undefined) continue;
    const parsed = stringList(value[key], `${path}.${key}`);
    if (!parsed.ok) return parsed;
    when[key] = parsed.value;
  }
  if (value.changedLines !== undefined) {
    const lines = value.changedLines;
    if (!isRecord(lines)) {
      return { ok: false, problem: `${path}.changedLines must be an object` };
    }
    const bad = unknownKey(lines, ["min", "max"], `${path}.changedLines`);
    if (bad) return { ok: false, problem: bad };
    for (const key of ["min", "max"] as const) {
      const bound = lines[key];
      if (
        bound !== undefined &&
        (!Number.isInteger(bound) || Number(bound) < 0)
      ) {
        return {
          ok: false,
          problem: `${path}.changedLines.${key} must be a whole number of 0 or more`,
        };
      }
    }
    when.changedLines = lines as { min?: number; max?: number };
  }
  return { ok: true, value: when };
}

function parseAction(value: unknown, path: string): Check<PolicyAction> {
  if (!(ACTIONS as readonly unknown[]).includes(value)) {
    return {
      ok: false,
      problem: `${path} must be one of ${ACTIONS.join(", ")}`,
    };
  }
  return { ok: true, value: value as PolicyAction };
}

/** Turns stored or user supplied policy data into a policy, or says what is
 * wrong with it. A string names a template, an object is a full policy where
 * every setting but the rules can be left out. */
export function parsePolicy(value: unknown): Check<ReviewPolicy> {
  if (typeof value === "string") {
    const template = TEMPLATES[value];
    if (!template) {
      return {
        ok: false,
        problem: `unknown template "${value}", expected one of ${TEMPLATE_NAMES.join(", ")} or a policy object`,
      };
    }
    return { ok: true, value: withDefaults(template) };
  }
  if (!isRecord(value)) {
    return { ok: false, problem: "a policy is a template name or an object" };
  }
  const extra = unknownKey(
    value,
    [
      "rules",
      "default",
      "requestLabel",
      "requestCommand",
      "requesters",
      "approvalScope",
      "maxRounds",
    ],
    "policy",
  );
  if (extra) return { ok: false, problem: extra };
  const input: PolicyInput = {};
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules)) {
      return { ok: false, problem: "rules must be a list" };
    }
    const rules: PolicyRule[] = [];
    for (let index = 0; index < value.rules.length; index++) {
      const path = `rules[${index}]`;
      const rule = value.rules[index];
      if (!isRecord(rule)) {
        return { ok: false, problem: `${path} must be an object` };
      }
      const bad = unknownKey(rule, ["name", "when", "action"], path);
      if (bad) return { ok: false, problem: bad };
      const when = parseWhen(rule.when ?? {}, `${path}.when`);
      if (!when.ok) return when;
      const action = parseAction(rule.action, `${path}.action`);
      if (!action.ok) return action;
      if (rule.name !== undefined && typeof rule.name !== "string") {
        return { ok: false, problem: `${path}.name must be text` };
      }
      rules.push({ name: rule.name, when: when.value, action: action.value });
    }
    input.rules = rules;
  }
  if (value.default !== undefined) {
    const action = parseAction(value.default, "default");
    if (!action.ok) return action;
    input.default = action.value;
  }
  for (const key of ["requestLabel", "requestCommand"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !(value[key] as string).trim()) {
      return { ok: false, problem: `${key} must be non-empty text` };
    }
    input[key] = (value[key] as string).trim();
  }
  if (value.requesters !== undefined) {
    const parsed = associations(value.requesters, "requesters");
    if (!parsed.ok) return parsed;
    input.requesters = parsed.value;
  }
  if (value.approvalScope !== undefined) {
    if (
      value.approvalScope !== "head" &&
      value.approvalScope !== "pull-request"
    ) {
      return {
        ok: false,
        problem: "approvalScope must be head or pull-request",
      };
    }
    input.approvalScope = value.approvalScope;
  }
  if (value.maxRounds !== undefined) {
    if (!Number.isInteger(value.maxRounds) || Number(value.maxRounds) < 1) {
      return {
        ok: false,
        problem: "maxRounds must be a whole number of 1 or more",
      };
    }
    input.maxRounds = Number(value.maxRounds);
  }
  return { ok: true, value: withDefaults(input) };
}

/** What the dashboard shows next to each template, one plain sentence each. */
export const TEMPLATE_INFO: {
  name: string;
  label: string;
  description: string;
}[] = [
  {
    name: "everyone",
    label: "Everyone",
    description:
      "Every pull request is reviewed automatically, except drafts and pull requests by bots.",
  },
  {
    name: "trusted-auto",
    label: "Trusted authors, automatic",
    description:
      "Owners, members and collaborators are reviewed automatically. Everyone else waits until a maintainer asks.",
  },
  {
    name: "on-request-only",
    label: "Only when requested",
    description:
      "Nothing is reviewed until a maintainer asks, with a label or a comment.",
  },
];

const ASSOCIATION_WORDS: Record<Association, string> = {
  OWNER: "owners",
  MEMBER: "members",
  COLLABORATOR: "collaborators",
  CONTRIBUTOR: "earlier contributors",
  FIRST_TIME_CONTRIBUTOR: "first time contributors",
  FIRST_TIMER: "first timers",
  NONE: "people with no relation to the repository",
};

function joinWords(words: string[], joiner: string): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${joiner} ${words.at(-1)}`;
}

function describeWhen(when: RuleWhen): string {
  const empty = Object.keys(when).length === 0;
  if (empty) return "All pull requests";
  let subject = "Pull requests";
  if (when.draft === true && when.bot === true) {
    subject = "Draft pull requests by bots";
  } else if (when.draft === true) {
    subject = "Draft pull requests";
  } else if (when.bot === true) {
    subject = "Pull requests by bots";
  }
  const extras: string[] = [];
  if (when.draft === false) extras.push("that are ready for review");
  if (when.bot === false) extras.push("not by bots");
  if (when.association) {
    extras.push(
      `by ${joinWords(
        when.association.map((a) => ASSOCIATION_WORDS[a]),
        "or",
      )}`,
    );
  }
  if (when.fork === true) extras.push("opened from a fork");
  if (when.fork === false) extras.push("opened from the repository itself");
  if (when.labels) extras.push(`labeled ${joinWords(when.labels, "or")}`);
  if (when.targetBranch) {
    extras.push(`into ${joinWords(when.targetBranch, "or")}`);
  }
  const lines = when.changedLines;
  if (lines) {
    if (lines.min !== undefined && lines.max !== undefined) {
      extras.push(`changing ${lines.min} to ${lines.max} lines`);
    } else if (lines.min !== undefined) {
      extras.push(`changing at least ${lines.min} lines`);
    } else if (lines.max !== undefined) {
      extras.push(`changing at most ${lines.max} lines`);
    }
  }
  return [subject, ...extras].join(" ");
}

const PLURAL_ACTION: Record<PolicyAction, string> = {
  review: "are reviewed automatically.",
  "on-request": "wait for a maintainer request.",
  skip: "are not reviewed.",
};

const SINGULAR_ACTION: Record<PolicyAction, string> = {
  review: "is reviewed automatically.",
  "on-request": "waits for a maintainer request.",
  skip: "is not reviewed.",
};

/** The policy as short sentences a maintainer can read before saving it. */
export function describePolicy(policy: ReviewPolicy): string[] {
  const lines = policy.rules.map(
    (rule) => `${describeWhen(rule.when)} ${PLURAL_ACTION[rule.action]}`,
  );
  lines.push(
    policy.rules.length === 0
      ? `Every pull request ${SINGULAR_ACTION[policy.default]}`
      : `Any other pull request ${SINGULAR_ACTION[policy.default]}`,
  );
  const waits =
    policy.default === "on-request" ||
    policy.rules.some((rule) => rule.action === "on-request");
  if (waits) {
    const who = joinWords(
      policy.requesters.map((a) => ASSOCIATION_WORDS[a]),
      "and",
    );
    const scope =
      policy.approvalScope === "head"
        ? "A request covers the commit it was made on."
        : "A request covers every later push to the pull request.";
    lines.push(
      `${who.charAt(0).toUpperCase()}${who.slice(1)} can ask by adding the label "${policy.requestLabel}" or by commenting "${policy.requestCommand}". ${scope}`,
    );
  }
  if (policy.maxRounds !== undefined) {
    lines.push(
      `A pull request gets at most ${policy.maxRounds} ${policy.maxRounds === 1 ? "review" : "reviews"} from the webhook.`,
    );
  }
  return lines;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What to store for a policy: the template's name when the policy is exactly
 * that template with the default settings, the whole policy otherwise. */
export function storedPolicyValue(policy: ReviewPolicy): string | ReviewPolicy {
  const wanted = canonical(policy);
  for (const name of TEMPLATE_NAMES) {
    if (canonical(withDefaults(TEMPLATES[name]!)) === wanted) return name;
  }
  return policy;
}

/** What a form or API caller sent, as the value to store. `null` clears the
 * choice, and `"legacy"` (the simple switches) is only for one repository. */
export function policyToStore(
  value: unknown,
  options: { allowLegacy: boolean },
): Check<string | null> {
  if (value === null) return { ok: true, value: null };
  if (value === "legacy") {
    return options.allowLegacy
      ? { ok: true, value: '"legacy"' }
      : { ok: false, problem: "the simple switches only exist per repository" };
  }
  const parsed = parsePolicy(value);
  if (!parsed.ok) return parsed;
  return { ok: true, value: JSON.stringify(storedPolicyValue(parsed.value)) };
}
