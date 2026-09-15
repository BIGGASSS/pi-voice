import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  KeybindingsManager,
  matchesKey,
  type Keybinding,
  type KeybindingDefinitions,
  type KeyId,
} from "@earendil-works/pi-tui";

/**
 * Every key pi-transcribe binds itself, in pi's definition shape. Users
 * override these with the same ids in pi's keybindings.json; pi keeps entries
 * it does not recognise and hands them back through `getUserBindings()`.
 *
 * Navigation, confirm, and cancel come from pi's `tui.*` ids. Tab is ours: it
 * continues the language step and browses from Your models. The model pickers
 * in between swallow the Continue key so the setup sequence never reads Tab as
 * "go back".
 */
export const TRANSCRIBE_KEYBINDINGS = {
  "transcribe.languages.toggle": { defaultKeys: "space", description: "Toggle the highlighted language" },
  "transcribe.languages.continue": { defaultKeys: "tab", description: "Continue with the selected languages" },
  "transcribe.languages.change": { defaultKeys: "ctrl+l", description: "Change spoken languages" },
  "transcribe.recommendations.browseAll": { defaultKeys: "o", description: "Browse all models" },
  "transcribe.yourModels.browse": { defaultKeys: "tab", description: "Browse all models" },
  "transcribe.models.ratingsHelp": { defaultKeys: "?", description: "Open the rating guide" },
  "transcribe.ratingsHelp.close": { defaultKeys: "q", description: "Close the rating guide" },
  "transcribe.scroll.top": { defaultKeys: "home", description: "Scroll to the top" },
  "transcribe.scroll.bottom": { defaultKeys: "end", description: "Scroll to the bottom" },
  "transcribe.tryIt.shortcut": { defaultKeys: "s", description: "Change the dictation shortcut" },
  "transcribe.tryIt.microphone": { defaultKeys: "m", description: "Change the microphone" },
  "transcribe.tryIt.model": { defaultKeys: "c", description: "Change the model" },
  "transcribe.shortcut.useDefault": { defaultKeys: "d", description: "Use the default shortcut" },
  "transcribe.dictation.cancel": { defaultKeys: "escape", description: "Cancel recording or transcription" },
} as const satisfies KeybindingDefinitions;

export type TranscribeKeybinding = keyof typeof TRANSCRIBE_KEYBINDINGS;
/** A pi `tui.*` id or one of ours; callers never need to know which. */
export type KeyAction = Keybinding | TranscribeKeybinding;

export function isTranscribeKeybinding(id: string): id is TranscribeKeybinding {
  return Object.hasOwn(TRANSCRIBE_KEYBINDINGS, id);
}

// Our ids are not declaration-merged into pi's `Keybindings`, so pi's manager
// would silently accept them and never match. Route by table membership instead.
const asTuiId = (id: TranscribeKeybinding): Keybinding => id as unknown as Keybinding;

function matchesLocalKey(data: string, key: KeyId): boolean {
  if (matchesKey(data, key)) return true;
  // Single printable keys also accept the shifted or caps-lock form and Kitty's
  // CSI-u report of the typed character, such as `?` arriving as shift+/.
  if (key.length !== 1) return false;
  const typed = data.length === 1 ? data : decodeKittyPrintable(data);
  return typed?.toLowerCase() === key;
}

/** The user's dictation shortcut is a runtime setting, not a table entry. */
export function matchesShortcut(data: string, shortcut: string): boolean {
  return matchesKey(data, shortcut as KeyId);
}

/**
 * One matcher and one hint formatter over pi's manager and our table.
 * Built per pane from the manager pi injects, so the user's bindings for both
 * apply. Construct it fresh rather than caching: pi's /reload swaps the user
 * bindings on its manager and the local copy is a snapshot.
 */
export class TranscribeKeys {
  private readonly local: KeybindingsManager;

  constructor(readonly host: KeybindingsManager) {
    this.local = new KeybindingsManager(TRANSCRIBE_KEYBINDINGS, host.getUserBindings());
  }

  matches(data: string, id: KeyAction): boolean {
    if (!isTranscribeKeybinding(id)) return this.host.matches(data, id);
    return this.local.getKeys(asTuiId(id)).some((key) => matchesLocalKey(data, key));
  }

  keys(id: KeyAction): KeyId[] {
    return isTranscribeKeybinding(id) ? this.local.getKeys(asTuiId(id)) : this.host.getKeys(id);
  }

  keyText(id: KeyAction | readonly KeyAction[]): string {
    const ids = Array.isArray(id) ? (id as readonly KeyAction[]) : [id as KeyAction];
    return ids.flatMap((each) => this.keys(each)).join("/");
  }

  hint(id: KeyAction | readonly KeyAction[], description: string): string {
    return rawKeyHint(this.keyText(id), description);
  }

  navLabel(): string {
    const up = this.keys("tui.select.up");
    const down = this.keys("tui.select.down");
    const arrows = up.includes("up") && down.includes("down");
    return arrows ? "↑↓" : `${up.join("/")}/${down.join("/")}`;
  }

  navHint(description: string): string {
    return rawKeyHint(this.navLabel(), description);
  }
}
