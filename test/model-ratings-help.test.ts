import assert from "node:assert/strict";
import { test } from "node:test";
import { isRatingsHelpKey } from "../src/model-ratings-help.js";

const ESC = "\u001b";

test("the help shortcut accepts typed and Kitty-protocol question marks only", () => {
  for (const data of ["?", `${ESC}[63u`, `${ESC}[63;2u`, `${ESC}[47:63;2u`]) {
    assert.equal(isRatingsHelpKey(data), true, JSON.stringify(data));
  }
  for (const data of ["/", "qwen?", `${ESC}[200~?${ESC}[201~`, `${ESC}[63;5u`]) {
    assert.equal(isRatingsHelpKey(data), false, JSON.stringify(data));
  }
});
