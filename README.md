# claude-google-meet-chat-helper

A standalone Node script that observes a live Google Meet, scrapes captions,
and asks Claude every 2 minutes whether there's a thread the facilitator
should pull on. If yes, a small nudge appears in the corner of the Meet tab.

Built for facilitating workflow-discovery sessions where a teammate walks
through an annoying task and you're trying to spot the friction worth
automating.

## Setup

Requires Node 20+ and a logged-in Claude Code CLI (`claude`).

```sh
npm install
# confirm `claude` is on PATH and authenticated
claude --version
```

This branch uses `@anthropic-ai/claude-agent-sdk`, which shells out to your
local `claude` CLI for inference. Auth comes from your Claude
Pro/Max subscription — no `ANTHROPIC_API_KEY` needed.

If you'd rather pay per-token via the Anthropic API, switch to the
`feat/observer` branch which uses `@anthropic-ai/sdk` directly.

## Run

```sh
npm start
```

A Chromium window opens at `meet.google.com`. Steps:

1. Log into Google in that Chromium.
2. Join your Meet.
3. Turn captions on (CC button, bottom toolbar).
4. Switch back to your terminal and press **Enter**.

You should now see caption lines streaming to the terminal:

```
[Alice] so the way I usually start is by exporting from Looker
[Bob] and then you paste it where
[Alice] yeah into the master sheet
```

Captions are also appended to `transcript-<timestamp>.jsonl` in the cwd.

After ~2 minutes Claude gets its first window of transcript and may emit a
nudge. When it does:

- Console: `💡 [now] What does "the master sheet" actually contain?`
- Overlay: a small dark card appears top-right of the Meet page with the
  same text. Border is orange for `now`, gray for `later`.

## Stop

Type `session over` + Enter in the terminal. The script writes a
`final-<timestamp>.json` containing the full structured transcript and
exits cleanly.

`Ctrl-C` also works — the JSONL transcript is already on disk from
append-as-you-go, you just don't get the structured final dump.

## Selector hunt

Meet's caption DOM changes. The selectors in `observer.js` are spec
defaults and almost certainly need updating:

```js
const nodes = document.querySelectorAll('[jsname="tgaKEf"], .iOzk7, .TBMuR');
const speaker = n.querySelector('.zs7s8d, .NWpY1d')?.textContent?.trim();
const text = n.querySelector('.bh44bd, .ygicle')?.textContent?.trim();
```

If captions aren't streaming after you press Enter:

1. In the Puppeteer Chromium, right-click a caption row → **Inspect**.
2. Note the container's `jsname=` or class.
3. Replace the three selector strings in `observer.js`.
4. Restart `npm start`.

Budget 5 minutes. If selectors take longer than that, fall back to
Gemini's official transcript at the end of your session.

## Configuration

In `observer.js` near the top:

| Const | Default | What it does |
|-------|---------|---|
| `NUDGE_INTERVAL_MS` | `2 * 60 * 1000` | How often Claude is asked for a nudge. |
| `MODEL_ID` | `opus` | Claude Agent SDK model alias (`opus`, `sonnet`, `haiku`) or full id like `claude-opus-4-7`. |

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
4. In `observer.js`, replace:
   ```js
   const browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
   const page = (await browser.pages())[0];
   await page.goto('https://meet.google.com/');
   ```
   with:
   ```js
   const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
   const pages = await browser.pages();
   const page = pages.find(p => p.url().includes('meet.google.com')) || pages[0];
   ```
5. `npm start`.

## Files in cwd at runtime

- `transcript-<timestamp>.jsonl` — append-only, one JSON line per deduped caption.
- `final-<timestamp>.json` — written on `session over`, full structured dump.

Both are gitignored.

## What this is not

No persistence between sessions, no post-session analysis, no Gemini gem
construction, no UI beyond the overlay div. By design.
