/** `/setup` walks the checklist one step at a time, with Back, Next and the
 * progress at the top, and ends on a preview of a review comment. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { readConfig } from "../../config.ts";

test("the wizard opens on the first step not done and links Back and Next", async () => {
  await withDashboard(async (get) => {
    // A fresh install has gh access, so GitHub is done and AI comes first.
    const first = (await get("/setup")).html;
    assert.ok(first.includes(`data-step="ai"`), "not on the AI step");
    assert.ok(
      first.includes(
        `<button class="btn out" type="button" disabled>Back</button>`,
      ),
    );
    assert.ok(
      first.includes(`href="/setup?step=github" rel="next">Skip for now</a>`),
    );
    assert.match(first, /<li class="done"><a href="\/setup\?step=github">/);
    assert.ok(first.includes("step 1 of 5"));

    const github = (await get("/setup?step=github")).html;
    assert.ok(github.includes(`href="/setup?step=ai" rel="prev">Back</a>`));
    assert.ok(
      github.includes(`rel="next">Next</a>`),
      "a done step does not say Next",
    );
    assert.ok(github.includes(">Done</span>"));

    const look = (await get("/setup?step=look")).html;
    assert.ok(look.includes(`<a class="btn primary" href="/">Finish</a>`));
    assert.ok(look.includes(`id="rv-preview" data-blocking="model"`));
    // Both blocking rules are in the page, with their own labels for the
    // same P1 finding.
    assert.ok(
      look.includes(
        `when-model">\n    <p class="rv-h"><b>[P1 · non-blocking]</b>`,
      ),
    );
    assert.ok(
      look.includes(
        `when-severity">\n    <p class="rv-h"><b>[P1 · blocking]</b>`,
      ),
    );
    assert.ok(look.includes("when-plantuml"));
  });
});

test("saving the blocking rule marks the look step done", async () => {
  await withDashboard(async (get, send) => {
    const saved = await send("PUT", "/api/settings", {
      reviewBlocking: "severity",
    });
    assert.equal(saved.status, 200);
    assert.equal(readConfig().reviewBlocking, "severity");
    const look = (await get("/setup?step=look")).html;
    assert.ok(look.includes(`data-blocking="severity"`));
    assert.match(look, /<li class="done on"><a href="\/setup\?step=look"/);
    const bad = await send("PUT", "/api/settings", { reviewBlocking: "loud" });
    assert.equal(bad.status, 422);
  });
});
