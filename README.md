# Pi Voice

Local speech-to-text for Pi.

Press a keyboard shortcut, talk, and the resulting transcript will be put directly into your chat.

## Install

Install the npm package:

```bash
pi install npm:@earendil-works/pi-voice
```

If you prefer being on the development tip, you can install from GitHub:

```bash
pi install ssh://git@github.com/earendil-works/pi-voice
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- `/voice-settings` for preferred languages, model, transcription language, post-processing, microphone, and shortcut settings.

`/transcribe` remains available as a compatibility alias for `/voice-settings`. The `/voice` command is reserved for a future voice mode.

## Upgrading from pi-transcribe

It's recommended to install Pi Voice via NPM. If you have an older install of pi-transcribe uninstall it via:

```bash
pi remove git:github.com/earendil-works/pi-transcribe
```

If you installed it into a project with `-l`, run `pi remove -l git:github.com/earendil-works/pi-transcribe` from that project instead. Then install Pi Voice with:

```bash
pi install npm:@earendil-works/pi-voice
```

This checkout omits upstream's `transcribe_file` tool; only microphone dictation is available. The upstream npm package and GitHub install include the tool.

Press the shortcut while Pi has focus, speak, then press it again. A live level meter appears above the editor while recording. `Esc` cancels. Audio is transcribed locally and inserted at the editor cursor. Streaming-capable models process roughly 500 ms audio chunks while recording; other models use the complete recording after it stops. The shortcut is a Pi terminal binding, not a global OS hotkey.

## Optional transcript correction

LLM post-processing is **off by default**. In `/voice-settings` → **Post-processing**, choose a specific LLM from your available Pi providers, then enable correction. This selection is independent of—and never changes—the main session model.

**When enabled, transcript text is sent to the chosen provider and may cost money.** Audio transcription still runs locally. Leave post-processing disabled to keep Pi Voice from sending transcripts to an LLM.

The default prompt conservatively fixes ASR typos and punctuation, preserving meaning and the original language. It tells the LLM not to answer or execute dictated commands and to return only the corrected transcript. Use **Edit correction prompt** to edit the full prompt, or **Reset correction prompt** to restore the default. Review corrected text before submitting it: LLMs can make mistakes.

Correction runs after ASR finishes and before text is pasted into the editor. `Esc` cancels both stages. If the LLM is unavailable, fails, returns empty/incomplete output, or takes longer than 30 seconds, Pi Voice warns and keeps the original ASR transcript instead.

Changes save immediately in Pi's agent settings directory (`~/.pi/agent/pi-voice.json` by default). The chosen LLM and prompt are retained when correction is disabled or the local ASR model is changed. Older configurations remain disabled until you opt in.

## Developing & Building Pi Voice

To develop or run it from a checkout:

```bash
git clone git@github.com:earendil-works/pi-voice.git
cd pi-voice
npm install --ignore-scripts
pi -e .
```

If you want to be able to re-run onboarding you can enable the debug env var when starting Pi. This enables the `/voice-onboarding` command.

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-voice
```

Run `/voice-onboarding` to replay setup. Canceling before selecting a model leaves the current configuration unchanged; model selections are applied immediately.
