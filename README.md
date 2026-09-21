# Pi Voice

Local voice dictation and speech-to-text for Pi.

## Install

Install directly from GitHub:

```bash
pi install ssh://git@github.com/earendil-works/pi-voice
```

Or install the published npm package:

```bash
pi install npm:@earendil-works/pi-voice
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- a `transcribe_file` tool that the agent can use to transcribe local audio or video files;
- `/voice-settings` for preferred languages, model, transcription language, microphone, and shortcut settings.

`/transcribe` remains available as a compatibility alias for `/voice-settings`. The `/voice` command is reserved for a future voice mode.

To develop or run it from a checkout:

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-voice
```

While iterating on setup, enable the debug-only onboarding command when starting Pi:

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-voice
```

Then run `/voice-onboarding` to replay the complete onboarding flow. The command is not registered unless `PI_VOICE_DEBUG=1`. Canceling before selecting a model leaves the current configuration unchanged; model selections are applied immediately.

Press the shortcut while Pi has focus, speak, then press it again. A live level meter appears above the editor while recording. `Esc` cancels. Audio is transcribed locally and inserted at the editor cursor. Streaming-capable models process roughly 500 ms audio chunks while recording; other models use the complete recording after it stops. The shortcut is a Pi terminal binding, not a global OS hotkey.

## Upgrading from pi-transcribe

Existing Git installs keep working: GitHub redirects the old repository URL, so `pi update --extensions` updates them to the Pi Voice code. Settings in `pi-transcribe.json` are migrated automatically to `pi-voice.json` the first time they are read, and custom `transcribe.*` keybindings in `keybindings.json` still apply until you rename them to `voice.*`.

To reinstall under the new name, remove the old package first so Pi does not load both copies of the extension:

```bash
pi remove git:github.com/earendil-works/pi-transcribe
```

If you installed it into a project with `-l`, run `pi remove -l git:github.com/earendil-works/pi-transcribe` from that project instead. Then install Pi Voice with either command above. Your settings are kept.

## File transcription and FFmpeg

The agent can call `transcribe_file` for local audio or video files. Transcription jobs share one loaded model; queued files reuse it, while microphone dictation runs before waiting file jobs after any active job finishes. To bound memory use, at most two file operations are admitted at once, only one FFmpeg decoder runs at a time, and decoded audio is limited to 128 MiB (about 35 minutes). File decoding requires the `ffmpeg` executable; microphone dictation does not. Install FFmpeg with your system package manager:

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point Pi Voice at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

The legacy `PI_TRANSCRIBE_FFMPEG_PATH` variable remains supported when `PI_VOICE_FFMPEG_PATH` is not set.

When FFmpeg is unavailable, `transcribe_file` reports platform-specific guidance to the agent. The agent should ask before running a package-manager command. Model setup is still explicit: run `/voice-settings` once in the interactive TUI to choose and, after confirmation, download a local model.
