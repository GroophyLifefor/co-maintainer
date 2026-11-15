import { REVIEW_COPY_RULE } from "../pr/review_copy.ts";
import type { AiProvider, AiRequest } from "../types.ts";

/** The punctuation rule is a brand rule, not a fix for one prompt. Every AI
 * job, present or future, gets it in its system prompt from here, so a new job
 * cannot forget it. The rule text lives once, in `REVIEW_COPY_RULE`. */
export function withCopyRuleRequest(request: AiRequest): AiRequest {
  if (request.system?.includes(REVIEW_COPY_RULE)) return request;
  return {
    ...request,
    system: request.system
      ? `${request.system}\n\n${REVIEW_COPY_RULE}`
      : REVIEW_COPY_RULE,
  };
}

/** A provider whose every request carries the copy rule. */
export function withCopyRule(provider: AiProvider): AiProvider {
  return {
    get supportsTools() {
      return provider.supportsTools;
    },
    complete: (request) => provider.complete(withCopyRuleRequest(request)),
  };
}
