import { extractFacts } from "./facts.ts";
import { qualityFixtures } from "../testing/fixtures/quality.ts";
import { testOptions } from "../testing/helpers.ts";

Deno.test("facts remain useful for a non-Rust, non-npm fixture", () => {
  const facts = extractFacts(qualityFixtures.node, testOptions());
  if (!facts.some((item) => item.sectionKey === "layout")) {
    throw new Error("expected a module layout fact");
  }
  if (!facts.some((item) => item.claim.includes("pnpm test"))) {
    throw new Error("expected the configured package-manager command");
  }
  if (facts.some((item) => /Rust|cargo/i.test(item.claim))) {
    throw new Error("fixture received language-specific Rust guidance");
  }
  if (facts.some((item) => !item.scope || !item.confidence || !item.status)) {
    throw new Error("fact provenance metadata is missing");
  }
});

Deno.test("quality fixtures cover different repository shapes", () => {
  const cargoFacts = extractFacts(qualityFixtures.cargo, testOptions());
  if (!cargoFacts.some((item) => /cargo test/i.test(item.claim))) {
    throw new Error("Cargo fixture did not produce test guidance");
  }
  const docsFacts = extractFacts(qualityFixtures.docs, testOptions());
  if (!docsFacts.some((item) => item.sectionKey === "devloop")) {
    throw new Error(
      "documentation fixture did not produce development guidance",
    );
  }
});
