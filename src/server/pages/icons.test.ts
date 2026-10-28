import { test } from "node:test";
import { icon, iconNames, iconSprite } from "./ui.ts";
import { sprite } from "./icons.ts";

test("the sprite carries one symbol per embedded icon", () => {
  if (iconNames.length < 40) {
    throw new Error(`only ${iconNames.length} icons were embedded`);
  }
  if (new Set(iconNames).size !== iconNames.length) {
    throw new Error("an icon name is repeated");
  }
  for (const name of iconNames) {
    if (!sprite.includes(`<symbol id="i-${name}" viewBox="`)) {
      throw new Error(`sprite missed the symbol for ${name}`);
    }
  }
  const symbols = sprite.match(/<symbol /g)?.length ?? 0;
  if (symbols !== iconNames.length) {
    throw new Error(
      `sprite has ${symbols} symbols for ${iconNames.length} icons`,
    );
  }
});

test("the sprite is a hidden svg so it never takes space", () => {
  if (!sprite.startsWith("<svg ")) throw new Error("sprite is not an svg");
  if (!sprite.includes('aria-hidden="true"')) {
    throw new Error("sprite is exposed to assistive tech");
  }
  if (!sprite.includes("width:0")) throw new Error("sprite is visible");
});

test("icon() renders a use that points at the sprite", () => {
  const html = icon("git-pull-request");
  if (!html.includes('class="ic"')) throw new Error(html);
  if (!html.includes('href="#i-git-pull-request"')) throw new Error(html);
  if (!html.includes('aria-hidden="true"')) throw new Error(html);
});

test("an unknown icon name renders nothing rather than a broken box", () => {
  if (icon("not-a-real-icon") !== "") {
    throw new Error("an unknown icon did not degrade");
  }
});

test("iconSprite is the same document the icons module exports", () => {
  if (iconSprite !== sprite) throw new Error("iconSprite drifted from sprite");
});
