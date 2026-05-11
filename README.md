# opencode-cashback

`opencode-cashback` is an OpenCode plugin that reduces prompt size before messages are sent to the LLM, then shows the saved-character total live in the TUI.

It is built around one constraint: compression must be deterministic. The same input history should compress the same way every time, so you get smaller prompts without introducing cache-hostile randomness or paying for an extra model pass.

## Quick start

Install:

```bash
opencode plugin opencode-plugin-snip --global --force
```

Public package and source:

- npm: `opencode-plugin-snip`
- GitHub: `https://github.com/disrei/opencode-cashback`
- Release: `https://github.com/disrei/opencode-cashback/releases/tag/v0.1.0`

What you get immediately:

- Deterministic prompt compression before LLM submission.
- A live `snip` indicator in the OpenCode TUI.
- Per-session saved-character tracking that starts from `0.0k` in every new session.

## Why this plugin stands out

- Deterministic compression. No LLM rewriting step, no probabilistic summarization, no drifting history.
- Zero extra model cost. Compression is done with fixed rules over message parts and text.
- Session-scoped savings. Every session tracks its own saved-character total and starts from `0.0k`.
- Live TUI feedback. The current mode and cumulative savings are visible in the prompt row.
- Tool-aware cleanup. Tool payloads are normalized instead of blindly dumped back into history.
- Protected-block safe. `<system-reminder>...</system-reminder>` blocks are preserved.
- Three compression levels. Choose `pro`, `max`, or `max++` depending on how aggressive you want to be.

## Features

- Removes framework control events such as `[step-start]`, `[step-finish]`, and `[reasoning]` when they appear in framework-event form.
- Preserves non-framework user text that merely contains similar markers.
- Preserves `<system-reminder>...</system-reminder>` blocks.
- Normalizes tool output in `max` and `max++` modes.
- Replaces historical tool output bodies with a compact placeholder in `max++` mode while keeping the current turn's tool output intact.
- Tracks saved characters per session, not globally.
- Adds a bright yellow `snip` label to `home_prompt_right` and `session_prompt_right`.
- Keeps optional request logging off by default.

## What you see

In the TUI, the plugin shows a label like this:

```text
snip max 107.3k
```

<img width="310" height="69" alt="image" src="https://github.com/user-attachments/assets/9f0f91a9-be76-4cef-a37b-bd1726576f90" />



Meaning:

- `snip` is the plugin label.
- `max` is the active compression mode.
- `107.3k` is the cumulative characters saved for the current session only.

## Install

Install or upgrade from npm through OpenCode:

```bash
opencode plugin opencode-plugin-snip --global --force
```

OpenCode detects the plugin package from these exports:

- `exports["./server"]`
- `exports["./tui"]`

After install, OpenCode patches the relevant config files for you.

Use `--force` even on first install so the same command also works for upgrades. This avoids keeping an older configured plugin version when OpenCode reports the plugin as already configured.

If you previously used a local prototype plugin under `~/.config/opencode/plugins/`, remove old files there before testing the npm package. OpenCode can auto-discover plugins from that directory, and stale files like `log-llm.js` can end up running alongside the npm-installed plugin and overwrite the same stats file.

### Important: global install

Default behavior:

- Global install writes to `~/.config/opencode/opencode.json`
- Global install writes to `~/.config/opencode/tui.json`

Using plain `npm install opencode-plugin-snip` is not enough. The package must be installed through `opencode plugin ...` so OpenCode can patch the config files.


## Configuration

After install, OpenCode writes plugin entries into `opencode.json` and `tui.json`.

The server plugin supports these options:

```json
{
  "mode": "max",
  "logEnabled": false,
  "logPath": "C:/path/to/opencode-llm.log"
}
```

`logEnabled` defaults to `false`.

### Modes

`pro`

- Smallest behavior change.
- Best when you want conservative cleanup.
- Keeps tool payloads mostly intact.

`max`

- Default mode.
- Removes framework noise.
- Normalizes tool payloads.
- Best general-purpose setting.

`max++`

- Same as `max`, but only keeps full tool output after the most recent user message.
- Older tool results are only replaced when they are large enough to be worth compacting.
- Large historical tool results are retained as lightweight placeholders with status and output-size hints instead of full bodies.
- Historical tool output that contains `<system-reminder>` is kept intact.
- Best when old tool output is the main source of prompt bloat.
- Risk: if the model still needs exact details from an older tool result, `max++` can remove information that would otherwise still be available in history.

## TUI behavior

- The mode label comes from the server plugin config.
- The number is the cumulative saved characters for the current session only.
- A brand-new session starts at `0.0k`.
- The home screen shows `0.0k` because savings are session-based.

## Files written by the plugin

The plugin writes per-user runtime data under the OpenCode config directory:

- `~/.config/opencode/snip-stats.json`

Optional log output defaults to:

- `~/opencode-llm.log`

## How it works

Server side:

- Hooks `experimental.chat.system.transform`
- Hooks `experimental.chat.messages.transform`
- Compresses message parts deterministically.
- Removes control-event parts and matching framework-event text lines.
- Rewrites tool payloads into a smaller, stable format.
- Updates per-session saved-character stats.

TUI side:

- Registers `home_prompt_right`.
- Registers `session_prompt_right`.
- Polls the stats file and renders live saved-character counts.

## Local development

You can also use this package source directly as a local plugin during development.

Do not keep local-source mode and npm-installed mode active at the same time. Pick one path per test run.

Replace `/absolute/path/to/opencode-cashback` with your own local checkout path.

Example `opencode.json`:

```json
{
  "plugin": [
    [
      "/absolute/path/to/opencode-cashback/src/server.js",
      {
        "mode": "max",
        "logEnabled": false
      }
    ]
  ]
}
```

Example `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/absolute/path/to/opencode-cashback/src/tui.tsx"
  ]
}
```

## Publish to GitHub

This directory is ready to become a GitHub repository.

Typical steps:

```bash
git init
git add .
git commit -m "Initial plugin package"
gh repo create opencode-cashback --public --source . --remote origin --push
```

## Publish to npm

After the GitHub repo is ready and the package name is available:

```bash
npm publish --access public
```

If the package name is already taken, rename the `name` field in `package.json` first.

## Notes

- Do not publish your personal `opencode.json` with provider credentials.
- This package only contains the plugin code and documentation.
- The stats file is intentionally session-scoped so session totals do not bleed into each other.
