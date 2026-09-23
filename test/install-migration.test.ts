import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  SlashCommandInfo,
  SourceInfo,
} from "@earendil-works/pi-coding-agent";
import {
  claimLegacyGitNotice,
  findLegacyGitInstall,
  legacyGitMigrationMessage,
} from "../src/install-migration.js";

function command(
  source: string,
  options: Partial<SourceInfo> = {},
): SlashCommandInfo {
  return {
    name: "voice-settings",
    source: "extension",
    sourceInfo: {
      path: "/package/index.ts",
      source,
      scope: "user",
      origin: "package",
      ...options,
    },
  };
}

test("detects supported forms of the old pi-transcribe Git source", () => {
  for (const source of [
    "git:github.com/earendil-works/pi-transcribe",
    "git:git@github.com:earendil-works/pi-transcribe",
    "ssh://git@github.com/earendil-works/pi-transcribe",
    "https://github.com/earendil-works/pi-transcribe.git",
    "git:github.com/earendil-works/pi-transcribe@v0.1.0",
  ]) {
    assert.equal(findLegacyGitInstall([command(source)])?.source, source);
  }
});

test("does not flag npm, the renamed Git repository, or top-level checkouts", () => {
  assert.equal(
    findLegacyGitInstall([
      command("npm:@earendil-works/pi-transcribe"),
      command("git:github.com/earendil-works/pi-voice"),
      command("git:github.com/earendil-works/pi-transcribe", { origin: "top-level" }),
    ]),
    undefined,
  );
});

test("claims the migration notice only once", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-install-migration-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal(await claimLegacyGitNotice(), true);
  assert.equal(await claimLegacyGitNotice(), false);
});

test("migration guidance preserves the package scope", () => {
  const source = "git:github.com/earendil-works/pi-transcribe";
  const globalMessage = legacyGitMigrationMessage(command(source).sourceInfo);
  assert.match(globalMessage, new RegExp(`pi remove ${source}`));
  assert.match(globalMessage, /pi install npm:@earendil-works\/pi-voice/);

  const projectMessage = legacyGitMigrationMessage(
    command(source, { scope: "project" }).sourceInfo,
  );
  assert.match(projectMessage, new RegExp(`pi remove -l ${source}`));
  assert.match(projectMessage, /pi install -l npm:@earendil-works\/pi-voice/);
});
