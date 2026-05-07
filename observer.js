import puppeteer from 'puppeteer';
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';

const TRANSCRIPT_FILE = `transcript-${Date.now()}.jsonl`;
const NOTES_FILE = `notes-${Date.now()}.md`;
const MODEL_ID = 'opus';
const STATUS_INTERVAL_MS = 30 * 1000;
const SCRAPE_INTERVAL_MS = 3000;
const DEFAULT_NUDGE_INTERVAL_MS = 3 * 60 * 1000;

const seen = new Set();
const transcript = [];

let lastNudgeIndex = 0;
let lastStatusCount = 0;
let overlayAttachCount = 0;
let nudgeIntervalMs = DEFAULT_NUDGE_INTERVAL_MS;
let autoNudgeOn = true;
let nudgeTimer = null;
let busy = false;
let welcomeShown = false;

const NUDGE_PROMPT = `You are an observer for a creative-team workflow tutoring session.

A team member is walking through a real, annoying 30–50 minute task on screen share. The facilitator is running this session to identify an opportunity to build a Gemini gem that helps with this task.

Your job: every few minutes you receive the latest chunk of the meeting transcript. Decide whether there is ONE short suggestion the facilitator should consider asking right now to deepen the discovery — something that pulls on a thread the team mentioned but didn't explain, or a friction point worth pushing on.

Output JSON only, no markdown fences:
{ "urgency": "now" | "later" | "none", "text": "..." }

- "now" = ask this in the next minute or two, it's about something just said
- "later" = worth coming back to, the facilitator can save it for the end
- "none" = nothing worth surfacing this turn

Keep "text" to 1–2 short sentences. The facilitator is talking and listening simultaneously and will glance at the overlay for half a second.

Pay attention to: workflow entry points, handoffs, friction (operational/cognitive/technical), informal knowledge, repetitive manual steps, things they hand-wave past. Do NOT pattern-match toward AI solutions. Just observe and surface threads.`;

const CHAT_PROMPT = `You are an assistant for a workflow-discovery facilitator running a live screen-share session right now.

The facilitator is talking, listening, AND chatting with you in a side panel simultaneously. They will glance at your reply for one second between thoughts.

Rules:
- 1-3 sentences unless they explicitly ask for more.
- Ground answers in the transcript window when possible. If you have to speculate, say so plainly.
- If they ask "what should I push on" or similar, propose ONE thread, in question form, they could surface in the next minute.
- Don't recap what they said back to them. They were there.
- Plain text. No markdown headers, no bullet lists unless they ask for one.`;

const NOTES_PROMPT = `You are reading a partial transcript of a workflow-discovery session. The facilitator wants a structured snapshot of what you understand so far.

Output a markdown doc with these sections:

## Workflow overview
1-2 sentence framing of what this person actually does.

## Steps observed
Numbered, in the order they were described. Note where steps were hand-waved.

## Friction points
Bulleted. Cite the speaker if attributable.

## Open threads
Things mentioned but not explained. Worth pulling on later.

## Informal knowledge
Anything that sounds like "Marcus does this" or "I just know to..." — undocumented expertise worth capturing.

Be terse. The facilitator will skim this between sessions, not read it line by line. Output only the markdown — no preamble, no fences.`;

const HELP_TEXT = `Commands:
  /nudge       force a nudge from recent captions
  /notes       refresh notes-*.md from full transcript
  /interval N  set auto-nudge interval (seconds, min 10)
  /auto on|off  toggle auto-nudge
  /gemini …    (wip) ask Gemini-in-Meet
  /help        this list
  /quit or "session over"   end and dump final-*.json

Free text → chat with Claude (with recent transcript context).

Hotkeys (when the overlay is focused and input is empty):
  n=nudge  o=notes  t=type  ?=help  Esc=blur`;

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--start-maximized'],
});
const page = (await browser.pages())[0];

await page.exposeFunction('observerSubmit', handleSubmit);

await page.goto('https://meet.google.com/');

console.log('🟢 Log into Google and join the Meet. Press Enter here when captions are ON.');
process.stdin.once('data', () => startScraping());

async function startScraping() {
  console.log(`🔵 Capture started. Transcript → ${TRANSCRIPT_FILE}.`);
  console.log(`   Auto-nudge every ${nudgeIntervalMs / 1000}s. Drive the rest from the overlay.`);
  console.log(`   "session over" + Enter here is the escape hatch.`);

  process.stdin.on('data', (data) => {
    const cmd = data.toString().trim().toLowerCase();
    if (cmd === 'session over') endSession();
  });

  setInterval(scrapeOnce, SCRAPE_INTERVAL_MS);
  setInterval(printStatus, STATUS_INTERVAL_MS);
  startAutoNudge();
}

async function scrapeOnce() {
  try {
    const lines = await page.evaluate(() => {
      const nodes = document.querySelectorAll('[jsname="tgaKEf"], .iOzk7, .TBMuR');
      return Array.from(nodes).map(n => {
        const speaker = n.querySelector('.zs7s8d, .NWpY1d')?.textContent?.trim() || 'unknown';
        const text = n.querySelector('.bh44bd, .ygicle')?.textContent?.trim() || n.textContent?.trim() || '';
        return { speaker, text };
      }).filter(x => x.text);
    });

    for (const line of lines) {
      const key = `${line.speaker}::${line.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = { t: Date.now(), ...line };
      transcript.push(entry);
      fs.appendFileSync(TRANSCRIPT_FILE, JSON.stringify(entry) + '\n');
    }
  } catch (err) {
    console.error('scrape error:', err.message);
  }
  await injectOverlay();
}

function printStatus() {
  const total = transcript.length;
  const delta = total - lastStatusCount;
  lastStatusCount = total;
  const auto = autoNudgeOn ? `auto-nudge ${nudgeIntervalMs / 1000}s` : 'auto-nudge OFF';
  console.log(`📋 ${total} captions (+${delta}) | ${auto}`);
}

function startAutoNudge() {
  if (nudgeTimer) clearInterval(nudgeTimer);
  nudgeTimer = null;
  if (!autoNudgeOn) return;
  nudgeTimer = setInterval(() => runNudge({ silent: true, source: 'auto' }), nudgeIntervalMs);
}

async function handleSubmit(rawText) {
  const text = (rawText || '').trim();
  if (!text) return;

  if (!text.startsWith('/')) {
    await appendMessage({ role: 'user', text });
  }

  if (text.toLowerCase() === 'session over') {
    return endSession();
  }

  if (text.startsWith('/')) {
    const [cmdRaw, ...rest] = text.slice(1).split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = rest.join(' ');
    return dispatchCommand(cmd, arg);
  }

  return askClaude(text);
}

async function dispatchCommand(cmd, arg) {
  switch (cmd) {
    case 'help':
    case '?':
      return appendMessage({ role: 'system', text: HELP_TEXT });

    case 'nudge':
    case 'n':
      return runNudge({ source: 'manual' });

    case 'notes':
    case 'o':
      return runNotes();

    case 'gemini':
    case 'g':
      return appendMessage({
        role: 'system',
        text: `Gemini-in-Meet integration is WIP — coming next round. (You typed: "${arg}")`,
      });

    case 'interval': {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 10) {
        return appendMessage({ role: 'system', text: 'Usage: /interval <seconds>. Minimum 10.' });
      }
      nudgeIntervalMs = n * 1000;
      startAutoNudge();
      return appendMessage({ role: 'system', text: `Auto-nudge interval set to ${n}s.` });
    }

    case 'auto': {
      const a = arg.toLowerCase();
      if (a === 'on') {
        autoNudgeOn = true;
        startAutoNudge();
        return appendMessage({ role: 'system', text: `Auto-nudge ON, every ${nudgeIntervalMs / 1000}s.` });
      }
      if (a === 'off') {
        autoNudgeOn = false;
        startAutoNudge();
        return appendMessage({ role: 'system', text: 'Auto-nudge OFF.' });
      }
      return appendMessage({ role: 'system', text: 'Usage: /auto on|off' });
    }

    case 'quit':
      return endSession();

    case 'session':
      if (arg.toLowerCase() === 'over') return endSession();
      return appendMessage({ role: 'system', text: 'Did you mean "/session over"?' });

    default:
      return appendMessage({ role: 'system', text: `Unknown command: /${cmd}. Try /help.` });
  }
}

async function askClaude(userText) {
  if (busy) {
    return appendMessage({ role: 'system', text: 'Working on something — try again in a moment.' });
  }
  busy = true;
  await setStatus('thinking…');
  try {
    const recent = transcript.slice(-30).map(e => `${e.speaker}: ${e.text}`).join('\n');
    const prompt = `Recent transcript window:\n---\n${recent || '(no captions yet)'}\n---\n\nFacilitator: ${userText}`;
    const raw = await callClaude({ system: CHAT_PROMPT, prompt });
    await appendMessage({ role: 'assistant', text: raw.trim() || '(empty response)' });
  } catch (err) {
    await appendMessage({ role: 'error', text: `chat error: ${err.message}` });
  } finally {
    busy = false;
    await setStatus('idle');
  }
}

async function runNudge({ silent = false, source = 'manual' } = {}) {
  if (busy) {
    if (!silent) await appendMessage({ role: 'system', text: 'Working on something — try again in a moment.' });
    return;
  }
  busy = true;
  await setStatus(source === 'auto' ? 'auto-nudge…' : 'nudging…');
  try {
    const newEntries = transcript.slice(lastNudgeIndex);
    if (newEntries.length === 0) {
      if (!silent) await appendMessage({ role: 'system', text: 'No new captions to nudge on yet.' });
      return;
    }
    lastNudgeIndex = transcript.length;
    const transcriptText = newEntries.map(e => `${e.speaker}: ${e.text}`).join('\n');
    const raw = await callClaude({ system: NUDGE_PROMPT, prompt: transcriptText });
    let parsed;
    try {
      parsed = JSON.parse(stripFences(raw).trim());
    } catch {
      await appendMessage({ role: 'error', text: `nudge JSON parse failed. Raw: ${raw.slice(0, 120)}` });
      return;
    }
    if (parsed.urgency === 'none' || !parsed.text) {
      if (!silent) await appendMessage({ role: 'system', text: 'Nothing notable this turn.' });
      return;
    }
    console.log(`💡 [${parsed.urgency}] ${parsed.text}`);
    await appendMessage({ role: 'nudge', urgency: parsed.urgency, text: parsed.text });
  } catch (err) {
    await appendMessage({ role: 'error', text: `nudge error: ${err.message}` });
  } finally {
    busy = false;
    await setStatus('idle');
  }
}

async function runNotes() {
  if (busy) {
    return appendMessage({ role: 'system', text: 'Working on something — try again in a moment.' });
  }
  busy = true;
  await setStatus('writing notes…');
  try {
    const fullTranscript = transcript.map(e => `${e.speaker}: ${e.text}`).join('\n');
    const previous = fs.existsSync(NOTES_FILE) ? fs.readFileSync(NOTES_FILE, 'utf8') : '(no previous notes)';
    const prompt = `Previous notes:\n---\n${previous}\n---\n\nFull transcript so far:\n---\n${fullTranscript || '(no transcript yet)'}\n---\n\nWrite a fresh markdown notes doc per the system instructions.`;
    const raw = await callClaude({ system: NOTES_PROMPT, prompt });
    const md = stripFences(raw).trim();
    if (!md) {
      await appendMessage({ role: 'error', text: 'notes: empty response' });
      return;
    }
    fs.writeFileSync(NOTES_FILE, md);
    const wc = md.split(/\s+/).filter(Boolean).length;
    await appendMessage({ role: 'system', text: `Notes refreshed → ${NOTES_FILE} (${wc} words).` });
  } catch (err) {
    await appendMessage({ role: 'error', text: `notes error: ${err.message}` });
  } finally {
    busy = false;
    await setStatus('idle');
  }
}

async function callClaude({ system, prompt }) {
  const result = query({
    prompt,
    options: {
      systemPrompt: system,
      model: MODEL_ID,
      maxTurns: 1,
      tools: [],
      effort: 'low',
    },
  });
  let raw = '';
  for await (const msg of result) {
    if (msg.type !== 'assistant') continue;
    for (const block of msg.message.content) {
      if (block.type === 'text') raw += block.text;
    }
  }
  return raw;
}

async function injectOverlay() {
  try {
    const result = await page.evaluate(() => {
      if (document.getElementById('claude-observer-overlay')) {
        return { attached: false };
      }

      const setStyle = (el, styles) => { el.style.cssText = styles; };
      const make = (tag, styles, text) => {
        const el = document.createElement(tag);
        if (styles) setStyle(el, styles);
        if (text) el.textContent = text;
        return el;
      };

      const root = make('div',
        'position:fixed;top:80px;right:20px;z-index:2147483647;width:360px;max-height:70vh;display:flex;flex-direction:column;background:rgba(20,20,20,0.92);backdrop-filter:blur(10px);color:white;font:13px/1.4 system-ui,-apple-system,sans-serif;border-radius:10px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 32px rgba(0,0,0,0.5);pointer-events:auto;outline:none;');
      root.id = 'claude-observer-overlay';
      root.tabIndex = 0;

      // Restore saved position if present
      try {
        const saved = JSON.parse(localStorage.getItem('claude-observer-pos') || 'null');
        if (saved && typeof saved.left === 'string' && typeof saved.top === 'string') {
          root.style.left = saved.left;
          root.style.top = saved.top;
          root.style.right = 'auto';
        }
      } catch (e) { /* ignore */ }

      const header = make('div',
        'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.08);cursor:move;user-select:none;');
      const title = make('span', 'font-weight:600;letter-spacing:0.02em;pointer-events:none;', 'Claude Observer');
      const statusEl = make('span', 'font-size:11px;color:#9ca3af;', 'starting…');
      statusEl.id = 'co-status';
      header.appendChild(title);
      header.appendChild(statusEl);

      const feed = make('div',
        'flex:1;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:8px;min-height:140px;');
      feed.id = 'co-feed';

      const form = make('form',
        'display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid rgba(255,255,255,0.08);');
      const input = document.createElement('input');
      input.id = 'co-input';
      input.autocomplete = 'off';
      input.placeholder = 'Type or /command…  (n=nudge, o=notes, ?=help)';
      setStyle(input, 'flex:1;background:rgba(255,255,255,0.05);color:white;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:6px 10px;font:inherit;outline:none;');
      form.appendChild(input);

      const footer = make('div',
        'font-size:10px;color:#6b7280;padding:0 12px 8px 12px;letter-spacing:0.04em;',
        '[n]udge [o]notes [t]ype [?]help [Esc]blur');

      root.appendChild(header);
      root.appendChild(feed);
      root.appendChild(form);
      root.appendChild(footer);
      document.body.appendChild(root);

      window.__observerAppend = (msg) => {
        const role = msg.role;
        const isUser = role === 'user';
        const isNudge = role === 'nudge';
        const isSys = role === 'system';
        const isErr = role === 'error';

        const nudgeColor = msg.urgency === 'now' ? '#f97316' : '#9ca3af';
        const bg = isUser ? 'rgba(96,165,250,0.12)'
          : isNudge ? 'rgba(249,115,22,0.08)'
          : isErr ? 'rgba(252,165,165,0.10)'
          : isSys ? 'transparent'
          : 'rgba(255,255,255,0.04)';
        const fg = isErr ? '#fca5a5' : isSys ? '#9ca3af' : 'white';

        const css = [
          `padding:${isSys ? '2px 0' : '8px 10px'}`,
          'border-radius:8px',
          `align-self:${isUser ? 'flex-end' : 'flex-start'}`,
          'max-width:92%',
          `background:${bg}`,
          `color:${fg}`,
          isNudge ? `border-left:3px solid ${nudgeColor}` : '',
          isSys ? 'font-style:italic' : '',
          `font-size:${isSys || isErr ? '12px' : '13px'}`,
          'white-space:pre-wrap',
          'word-break:break-word',
        ].filter(Boolean).join(';');

        const bubble = make('div', css);

        if (isNudge) {
          const tag = make('div',
            `font-size:10px;color:${nudgeColor};font-weight:600;letter-spacing:0.06em;margin-bottom:4px;`,
            '💡 ' + (msg.urgency || '').toUpperCase());
          const body = make('div', '', msg.text);
          bubble.appendChild(tag);
          bubble.appendChild(body);
        } else if (isSys || isErr) {
          bubble.textContent = msg.text;
        } else {
          const label = make('div', 'font-size:10px;color:#9ca3af;margin-bottom:2px;',
            isUser ? 'you' : 'claude');
          const body = make('div', '', msg.text);
          bubble.appendChild(label);
          bubble.appendChild(body);
        }

        feed.appendChild(bubble);
        feed.scrollTop = feed.scrollHeight;
      };

      window.__observerStatus = (s) => { statusEl.textContent = s; };

      const submitText = (text) => {
        if (!text || !text.trim()) return;
        if (typeof window.observerSubmit !== 'function') {
          console.error('[observer] observerSubmit not bound on window');
          statusEl.textContent = 'binding error — see console';
          return;
        }
        Promise.resolve(window.observerSubmit(text)).catch((err) => {
          console.error('[observer] submit error:', err);
        });
      };

      // Direct Enter handler with capture+stopPropagation so Meet can't steal it.
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          const text = input.value;
          input.value = '';
          submitText(text);
        }
      }, true);

      // Block native form submission (Enter on input would otherwise reload).
      form.addEventListener('submit', (e) => { e.preventDefault(); });

      root.addEventListener('keydown', (e) => {
        const inputFocused = document.activeElement === input;
        if (!inputFocused) {
          if (e.key === 'n') { e.preventDefault(); e.stopPropagation(); submitText('/nudge'); return; }
          if (e.key === 'o') { e.preventDefault(); e.stopPropagation(); submitText('/notes'); return; }
          if (e.key === '?') { e.preventDefault(); e.stopPropagation(); submitText('/help'); return; }
          if (e.key === 't') { e.preventDefault(); e.stopPropagation(); input.focus(); return; }
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (inputFocused) { input.blur(); root.focus(); }
          else { root.blur(); }
        }
      }, true);

      // Drag from header
      let dragging = false;
      let dragStart = null;
      header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const rect = root.getBoundingClientRect();
        dragging = true;
        dragStart = { mx: e.clientX, my: e.clientY, rx: rect.left, ry: rect.top };
        e.preventDefault();
      });
      const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - dragStart.mx;
        const dy = e.clientY - dragStart.my;
        const left = Math.max(0, Math.min(window.innerWidth - 80, dragStart.rx + dx));
        const top = Math.max(0, Math.min(window.innerHeight - 60, dragStart.ry + dy));
        root.style.left = left + 'px';
        root.style.top = top + 'px';
        root.style.right = 'auto';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        try {
          localStorage.setItem('claude-observer-pos', JSON.stringify({
            left: root.style.left, top: root.style.top,
          }));
        } catch (e) { /* ignore */ }
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);

      return { attached: true };
    });

    if (result?.attached) {
      overlayAttachCount += 1;
      if (overlayAttachCount === 1 || overlayAttachCount % 5 === 0) {
        console.log(`🪟 overlay attached (count=${overlayAttachCount})`);
      }
      if (!welcomeShown) {
        welcomeShown = true;
        await appendMessage({ role: 'system', text: 'Observer ready. Type a message, hit ? for help, or use hotkeys (n/o/t).' });
        await setStatus('idle');
      }
    }
  } catch (err) {
    console.error('overlay inject error:', err.message);
  }
}

async function appendMessage(msg) {
  try {
    await page.evaluate((msg) => {
      if (window.__observerAppend) window.__observerAppend(msg);
    }, msg);
  } catch (err) {
    console.error('overlay append error:', err.message);
  }
}

async function setStatus(s) {
  try {
    await page.evaluate((s) => {
      if (window.__observerStatus) window.__observerStatus(s);
    }, s);
  } catch {
    // overlay may not be attached yet; non-fatal
  }
}

function endSession() {
  const finalFile = `final-${Date.now()}.json`;
  console.log(`🟡 Session ended. Writing ${transcript.length} entries to ${finalFile}.`);
  try {
    fs.writeFileSync(finalFile, JSON.stringify({
      transcript_file: TRANSCRIPT_FILE,
      notes_file: NOTES_FILE,
      ended_at: Date.now(),
      entry_count: transcript.length,
      transcript,
    }, null, 2));
  } catch (err) {
    console.error('final dump error:', err.message);
  }
  process.exit(0);
}

function stripFences(s) {
  return s.replace(/^```(?:\w+)?\s*/i, '').replace(/```\s*$/i, '');
}
