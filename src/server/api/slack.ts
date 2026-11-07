import { readConfig } from "../../config.ts";
import { postSlack } from "../../services/slack_notify.ts";
import { errorResponse } from "../errors.ts";
import { readJsonObject } from "./json_body.ts";

const TEST_MESSAGE =
  "co-maintainer test message. Review notices will arrive in this channel.";

/** `POST /api/slack/test`. Sends a test message to the URL in the body, so the
 * settings form can check a webhook before saving it, or to the saved one. */
export async function handleSlackTestRoute(
  request: Request,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const typed =
    typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : "";
  const target = typed || readConfig().slackWebhookUrl;
  if (!target) {
    return errorResponse(
      422,
      "slack_not_set",
      "Enter a Slack webhook URL first.",
    );
  }
  const ok = await postSlack(target, { text: TEST_MESSAGE });
  if (!ok) {
    return errorResponse(
      502,
      "slack_failed",
      "Slack did not accept the test message.",
    );
  }
  return Response.json({ ok: true });
}
