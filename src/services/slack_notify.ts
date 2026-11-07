import { readConfig } from "../config.ts";
import { log } from "../util/log.ts";

export type ReviewNotice = {
  repo: string;
  prNumber: number;
  findings: number;
  durationMs: number;
};

export type SlackPayload = { text: string };

/** One line per review, in Slack's mrkdwn. Slack renders `<url|label>` as a
 * link, so the PR number is clickable in the channel. */
export function slackMessage(notice: ReviewNotice): SlackPayload {
  const pr = `https://github.com/${notice.repo}/pull/${notice.prNumber}`;
  const what =
    notice.findings === 0
      ? "no actionable findings"
      : `${notice.findings} finding(s)`;
  const seconds = Math.max(1, Math.round(notice.durationMs / 1000));
  return {
    text: `co-maintainer reviewed <${pr}|${notice.repo}#${notice.prNumber}>: ${what} in ${seconds}s.`,
  };
}

/** Posts one message. A Slack outage must never fail a review, so every
 * problem is logged and reported as `false` instead of thrown. */
export async function postSlack(
  webhookUrl: string,
  payload: SlackPayload,
): Promise<boolean> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      log(
        "slack",
        `Slack webhook ${webhookUrl} answered ${response.status} ${response.statusText}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    log(
      "slack",
      `could not reach Slack webhook ${webhookUrl}: ${String(error)}`,
    );
    return false;
  }
}

/** Sends the notice when a Slack webhook is configured, and does nothing
 * otherwise. */
export async function notifyReviewPosted(notice: ReviewNotice): Promise<void> {
  const webhookUrl = readConfig().slackWebhookUrl;
  if (!webhookUrl) return;
  await postSlack(webhookUrl, slackMessage(notice));
}
