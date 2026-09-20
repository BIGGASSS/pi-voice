# pi-transcribe

Local speech-to-text dictation for Pi.

## Install

Install directly from GitHub:

```bash
pi install ssh://git@github.com/earendil-works/pi-transcribe
```

After the first npm release, it can also be installed with:

```bash
pi install npm:@earendil-works/pi-transcribe
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- `/transcribe` for preferred languages, model, transcription language, microphone, and shortcut settings.

To develop or run it from a checkout:

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-transcribe
```

While iterating on setup, enable the debug-only onboarding command when starting Pi:

```bash
PI_TRANSCRIBE_DEBUG=1 pi -e /absolute/path/to/pi-transcribe
```

Then run `/transcribe-onboarding` to replay the complete onboarding flow. The command is not registered unless `PI_TRANSCRIBE_DEBUG=1`. Canceling before selecting a model leaves the current configuration unchanged; model selections are applied immediately.

Press the shortcut while Pi has focus, speak, then press it again. A live level meter appears above the editor while recording. `Esc` cancels. Audio is transcribed locally and inserted at the editor cursor. Streaming-capable models process roughly 500 ms audio chunks while recording; other models use the complete recording after it stops. The shortcut is a Pi terminal binding, not a global OS hotkey.
