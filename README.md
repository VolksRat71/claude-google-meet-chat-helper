# claude-google-meet-chat-helper

A standalone Node script that observes a live Google Meet, scrapes captions,
and runs a small chat panel inside the Meet page so you can talk to Claude
while you facilitate. Claude can also nudge you on its own — the auto-nudge
loop watches the transcript and surfaces threads worth pulling on.

Built for facilitating workflow-discovery sessions where a teammate walks
through an annoying task and you're trying to spot the friction worth
automating.

## Setup

Requires Node 20+ and a logged-in Claude Code CLI (`claude`).

```sh
npm install
claude --version  # confirm it's on PATH and authenticated
```

This branch uses `@anthropic-ai/claude-agent-sdk`, which shells out to your
local `claude` CLI for inference. Auth comes from your Claude Pro/Max
subscription — no `ANTHROPIC_API_KEY` needed.

If you'd rather pay per-token via the Anthropic API, switch to the
`feat/observer` branch which uses `@anthropic-ai/sdk` directly.

## Run

```sh
npm start
```

1. Chromium opens at `meet.google.com`.
2. Log into Google in that Chromium.
3. Join your Meet.
4. Turn captions on (CC button, bottom toolbar).
5. Switch back to your terminal and press **Enter**.

A "Claude Observer" panel appears in the top-right of the Meet page. From
there everything happens in the panel — the terminal goes mostly silent.

## Using the panel

The panel has a scrolling feed and an input field at the bottom. Three
ways to use it:

- **Free chat** — type anything, hit Enter. Claude answers with the recent
  transcript window as context.
- **Slash commands** — see `/help` (below).
- **Hotkeys** — when the panel is focused (click on it) and the input is
  empty: `n` runs `/nudge`, `o` runs `/notes`, `t` jumps to the input,
  `?` shows help, `Esc` blurs back to Meet.

### Commands

```
/nudge        force a nudge from recent captions
/notes        refresh notes-*.md from full transcript
/interval N   set auto-nudge interval (seconds, min 10)
/auto on|off  toggle auto-nudge
/gemini …     (wip) ask Gemini-in-Meet — coming next round
/help         this list
/quit         end and dump final-*.json
```

`session over` typed in the panel input OR in the terminal also ends the
session.

### Auto-nudge

Defaults to every 3 minutes. Adjust on the fly: `/interval 90` for 90s,
`/auto off` to silence it, `/auto on` to bring it back. Auto-nudges only
fire on transcript chunks that haven't already been sent — they don't
double-up.

## Stop

Type `session over` (or `/quit`) in the panel. The script writes
`final-<timestamp>.json` containing the full structured transcript and
exits 0.

`Ctrl-C` also works as a floor — the JSONL transcript is already on disk.

## Files written at runtime

- `transcript-<ts>.jsonl` — append-only, one JSON line per deduped caption.
- `notes-<ts>.md` — refreshed by `/notes`. Same file is rewritten each call.
- `final-<ts>.json` — written on `session over` / `/quit`.

All three are gitignored.

## Configuration

Top of `observer.js`:

| Const | Default | What it does |
|-------|---------|---|
| `DEFAULT_NUDGE_INTERVAL_MS` | `3 * 60 * 1000` | Auto-nudge cadence at startup. Can be overridden live with `/interval`. |
| `MODEL_ID` | `opus` | Claude Agent SDK model alias (`opus`, `sonnet`, `haiku`) or full id like `claude-opus-4-7`. |

## Selector hunt

Meet's caption DOM drifts. The selectors in `observer.js` worked as of the
last live test, but if captions stop streaming after you press Enter:

1. In the Puppeteer Chromium, right-click a caption row → **Inspect**.
2. Note the container's `jsname=` or class.
3. Replace the three selector strings in `observer.js`.
4. Restart `npm start`.

## Google login fallback

Google sometimes blocks logins from a Puppeteer-launched Chromium ("This
browser or app may not be secure"). If that happens:

1. Quit the Puppeteer Chromium.
2. Launch your real Chrome with remote debugging:
   ```sh
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir=/tmp/chrome-meet-observer
   ```
3. In that Chrome, log into Google and join the Meet.
4. In `observer.js`, replace the `puppeteer.launch(...)` block with:
   ```js
   const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
   const pages = await browser.pages();
   const page = pages.find(p => p.url().includes('meet.google.com')) || pages[0];
   ```
5. `npm start`.

## What's still WIP

- `/gemini` — the plan is to drive the Gemini-in-Meet side panel via
  Puppeteer so Claude can autonomously query it as a tool. Not wired yet.
