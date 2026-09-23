import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Deferred } from "../src/deferred.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

type Step =
  | { type: "custom"; run: (pane: Component, done: (value: unknown) => void) => void | Promise<void> }
  | { type: "confirm"; run: (title: string, message: string) => boolean }
  | { type: "editor"; run: (title: string, prefill: string) => string | undefined };

export function scriptedSettingsContext(
  steps: Step[],
  models = [
    { provider: "provider-a", id: "correction-model", name: "Correction LLM" },
    { provider: "provider-b", id: "other-model", name: "Other LLM" },
  ],
) {
  let index = 0;
  const notifications: { message: string; type: string }[] = [];
  const ctx = {
    mode: "tui",
    get model() { return assert.fail("Correction configuration must not use the active session model"); },
    modelRegistry: { getAvailable: () => models },
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const result = new Deferred<unknown>();
        const pane = await factory(
          testTui(32), testTheme(), keybindings() as Parameters<typeof factory>[2],
          (value) => result.resolve(value),
        );
        try {
          const step = steps[index++];
          assert.ok(step?.type === "custom", `Unexpected pane: ${pane.constructor.name}`);
          await step.run(pane, (value) => result.resolve(value));
          return await result.promise;
        } finally {
          pane.dispose?.();
        }
      },
      confirm: async (title: string, message: string) => {
        const step = steps[index++];
        assert.ok(step?.type === "confirm", `Unexpected confirmation: ${title}`);
        return step.run(title, message);
      },
      editor: async (title: string, prefill: string) => {
        const step = steps[index++];
        assert.ok(step?.type === "editor", `Unexpected editor: ${title}`);
        return step.run(title, prefill);
      },
      notify: (message: string, type: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    notifications,
    assertFinished: () => assert.equal(index, steps.length),
  };
}

export function isolatedSettings(t: TestContext): string {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-post-processing-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
