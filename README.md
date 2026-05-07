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
/gemini       report Gemini-in-Meet drawer status
/gemini <q>   ask Gemini-in-Meet (drawer must be open)
/clear        reset chat memory (fresh conversation)
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
- `notes-<ts>.md` — refreshed by `/notes`. Same file is rewritten each call. `/notes` is incremental: only new captions since the last refresh are sent to Claude, plus the prior notes doc, so the prompt stays bounded as the meeting grows.
- `final-<ts>.json` — written on `session over` / `/quit`.
- `.observer-session` — last chat session ID. Persists chat continuity across script restarts; loaded automatically on next `npm start`. Run `/clear` to wipe.

All four are gitignored.

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

## Gemini-in-Meet integration

Open the Gemini drawer in Meet (sparkles icon, top-right toolbar). With it
open, two things become possible:

**Manual passthrough** via the `/gemini` command:
- `/gemini` (no args) — reports drawer status. If detected, prints the
  matched selectors. Useful for confirming the integration sees what you
  see before you ask a real question.
- `/gemini <question>` — types your question into the drawer's input,
  submits, polls until Gemini stops streaming, and posts the response
  back as a purple "✨ GEMINI" bubble in the panel feed.

**Autonomous tool use by Claude.** Claude is given `query_gemini` as a
tool via the Agent SDK's MCP support. When you free-chat with Claude
and the partial caption window doesn't have what Claude needs to answer
well, Claude can decide on its own to ask Gemini — Gemini has the full
Meet context (its own transcript, all participants, chat, metadata).
When that happens, you'll see a `claude → gemini: <question>` system
line in the feed, then Claude's final answer (which integrates Gemini's
response). Claude is instructed not to use the tool unnecessarily —
calls take 5–15 seconds.

Selectors are best-guesses against an undocumented Workspace UI. If the
drawer markup drifts, edit `GEMINI_SELECTORS` near the top of
`observer.js` to add new candidates. Order matters — first visible match
wins.

If `/gemini` says drawer not detected even though it's clearly open, open
DevTools in the Puppeteer Chromium, inspect the drawer container, and
extend `GEMINI_SELECTORS.drawers`.
