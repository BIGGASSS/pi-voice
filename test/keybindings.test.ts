import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { TranscribeKeys } from "../src/keybindings.js";
import { keybindings } from "./ui-helpers.js";

const ESC = String.fromCharCode(0x1b);
const ctrl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);
const matchesTranscribeKeybinding = (data: string, id: Parameters<TranscribeKeys["matches"]>[1]) =>
  new TranscribeKeys(keybindings()).matches(data, id);

test("the help shortcut accepts typed and Kitty-protocol question marks only", () => {
  for (const data of ["?", `${ESC}[63u`, `${ESC}[63;2u`, `${ESC}[47:63;2u`]) {
    assert.equal(matchesTranscribeKeybinding(data, "transcribe.models.ratingsHelp"), true, JSON.stringify(data));
  }
  for (const data of ["/", "qwen?", `${ESC}[200~?${ESC}[201~`, `${ESC}[63;5u`]) {
    assert.equal(matchesTranscribeKeybinding(data, "transcribe.models.ratingsHelp"), false, JSON.stringify(data));
  }
});

test("letter shortcuts accept either case and Kitty reports, never control keys", () => {
  for (const data of ["o", "O", `${ESC}[111u`, `${ESC}[111;2u`]) {
    assert.equal(matchesTranscribeKeybinding(data, "transcribe.recommendations.browseAll"), true, JSON.stringify(data));
  }
  for (const data of [ctrl("o"), "oo", `${ESC}[111;5u`]) {
    assert.equal(matchesTranscribeKeybinding(data, "transcribe.recommendations.browseAll"), false, JSON.stringify(data));
  }
  assert.equal(matchesTranscribeKeybinding(ctrl("l"), "transcribe.languages.change"), true);
  assert.equal(matchesTranscribeKeybinding("l", "transcribe.languages.change"), false);
});

test("TranscribeKeys routes pi ids to the injected manager and local ids to the table", () => {
  const keys = new TranscribeKeys(keybindings());
  assert.equal(keys.matches("\r", "tui.select.confirm"), true);
  assert.equal(keys.matches("\t", "transcribe.languages.continue"), true);
  assert.equal(keys.matches("\t", "tui.select.confirm"), false);
  assert.deepEqual(keys.keys("tui.select.cancel"), ["escape", "ctrl+c"]);
  assert.equal(keys.keyText(["transcribe.ratingsHelp.close", "tui.select.cancel"]), "q/escape/ctrl+c");
  assert.equal(keys.navLabel(), "↑↓");
});

test("navigation labels follow rebound pi keys", () => {
  const host = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "ctrl+p",
    "tui.select.down": "ctrl+n",
  });
  const keys = new TranscribeKeys(host);
  assert.equal(keys.navLabel(), "ctrl+p/ctrl+n");
  assert.equal(keys.matches(ctrl("p"), "tui.select.up"), true);
  assert.equal(keys.matches(`${ESC}[A`, "tui.select.up"), false);
});

test("transcribe ids in pi's user bindings override the table defaults", () => {
  const host = new KeybindingsManager(TUI_KEYBINDINGS, {
    "transcribe.recommendations.browseAll": "b",
    "tui.select.confirm": "ctrl+m",
  });
  const keys = new TranscribeKeys(host);
  assert.equal(keys.matches("b", "transcribe.recommendations.browseAll"), true);
  assert.equal(keys.matches("o", "transcribe.recommendations.browseAll"), false);
  assert.equal(keys.keyText("transcribe.recommendations.browseAll"), "b");
  // Unrelated overrides leave the table alone.
  assert.equal(keys.matches("?", "transcribe.models.ratingsHelp"), true);
});
