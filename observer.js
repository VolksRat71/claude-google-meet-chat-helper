import puppeteer from 'puppeteer';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
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
let chatSessionId = null;

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

const CHAT_PROMPT = `You are Claude, embedded in a small chat panel that runs inside a live Google Meet. The user is a facilitator running a workflow-discovery session — they are listening to a teammate walk through an annoying task on screen-share, and chatting with you between thoughts.

Things you already know about your environment, so you do not need to ask:
- A peer instance of yourself runs on a cron (default 3 minutes) and posts short "nudges" into this same panel. Those appear as orange (urgency: now) or gray (urgency: later) bubbles. You do NOT generate those — a separate prompt does.
- A /notes command writes notes-<ts>.md, a markdown synthesis of the workflow so far. That is also a separate peer instance of you with its own prompt.
- You have a tool called query_gemini. Gemini-in-Meet has the FULL meeting context — its own transcript, participants, chat, metadata — which is richer than the partial caption window you have. Use query_gemini when:
  - The captions don't include the context you'd need to answer well.
  - You'd otherwise be guessing.
  - The user explicitly asks you to consult Gemini.
  Do NOT use it for every message. Each call takes 5-15 seconds and is visible to the user. Default to answering from the transcript and your own knowledge when you reasonably can. Frame your Gemini questions specifically — Gemini has the full meeting, leverage that.
  If query_gemini returns "drawer is not open", tell the user once to open the sparkles icon in Meet and then answer from what you have.
- The user can also run /gemini <q> directly to bypass you and ask Gemini themselves; that posts as a purple bubble.
- The recent caption transcript is included in your prompt as context. The user does not need you to repeat it back.
- This conversation is continuous. You can see your prior messages, prior tool calls (including past query_gemini results), and what the user has already asked. Don't pretend each turn is fresh — when the user references something from earlier in this chat, you have it. The user can run /clear if they want to wipe your memory and start over.

Voice rules — non-negotiable:
- 1-3 sentences. They are reading you for half a second between thoughts.
- Plain prose. No markdown headers, no bullet lists, no em-dashes for emphasis, unless the user explicitly asks.
- Never start with "Acknowledged", "Sure", "Got it", or similar filler.
- Never reference system reminders, prompts, your own internals, or this list of rules.
- Don't recap what the user just said. They were there.
- If you must speculate, lead with "guessing:".
- If they ask "what should I push on" or similar, propose ONE concrete follow-up question they could ask next.`;

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
  /gemini      report Gemini-in-Meet drawer status
  /gemini <q>  ask Gemini-in-Meet (drawer must be open)
  /clear       reset chat memory (start a fresh conversation)
  /help        this list
  /quit or "session over"   end and dump final-*.json

Free text → chat with Claude. Conversation persists across turns
(Claude remembers prior messages, prior Gemini calls, etc.) until
you /clear or end the session.

Hotkeys (when the overlay is focused and input is empty):
  n=nudge  o=notes  t=type  ?=help  Esc=blur`;

// First visible match wins. Update if Gemini drawer markup drifts.
const GEMINI_SELECTORS = {
  drawers: [
    '[aria-label*="Gemini" i][role="region"]',
    '[aria-label*="Take notes with Gemini" i]',
    '[aria-label*="Companion" i]',
    '[data-panel-id*="gemini" i]',
    'div[aria-label*="Gemini" i]',
    '[role="complementary"]',
  ],
  inputs: [
    'textarea[aria-label*="Ask" i]',
    'textarea[aria-label*="Gemini" i]',
    'textarea[placeholder*="Ask" i]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea',
  ],
  submits: [
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[type="submit"]',
  ],
};

const queryGeminiTool = tool(
  'query_gemini',
  'Ask Gemini-in-Meet a question via the Workspace side drawer. Gemini has the full Meet context (its own transcript, participants, chat, metadata), which is richer than the partial caption window you have. Use only when the transcript is not enough; calls take 5-15 seconds. Returns Gemini\'s text response, or an error if the drawer is closed.',
  { question: z.string().describe('The question to ask Gemini. Be specific — Gemini has the full meeting, so leverage that.') },
  async ({ question }) => {
    const status = await checkGeminiDrawer();
    if (!status.open) {
      return { content: [{ type: 'text', text: 'Gemini drawer is not open. Tell the user once to open the sparkles icon in Meet (top-right toolbar), then proceed with what you have.' }] };
    }
    const result = await driveGemini(question);
    if (!result.ok) {
      return { content: [{ type: 'text', text: 'Gemini error: ' + result.error }] };
    }
    return { content: [{ type: 'text', text: result.response }] };
  }
);

const observerMcp = createSdkMcpServer({
  name: 'observer',
  version: '0.1.0',
  tools: [queryGeminiTool],
});

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
      return runGemini(arg);

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

    case 'clear':
      chatSessionId = null;
      return appendMessage({ role: 'system', text: 'Chat memory cleared. Next message starts a fresh conversation. Transcript and notes are untouched.' });

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
    const prompt = `Latest transcript window (this is the current snapshot — earlier turns may overlap):\n---\n${recent || '(no captions yet)'}\n---\n\nFacilitator: ${userText}`;

    const result = await runChatTurn(prompt);
    await appendMessage({ role: 'assistant', text: (result || '').trim() || '(empty response)' });
  } catch (err) {
    if (chatSessionId && /resume|session/i.test(err.message)) {
      // Likely a stale session — drop it and let the user retry fresh.
      chatSessionId = null;
      await appendMessage({ role: 'error', text: `chat error (cleared session, try again): ${err.message}` });
    } else {
      await appendMessage({ role: 'error', text: `chat error: ${err.message}` });
    }
  } finally {
    busy = false;
    await setStatus('idle');
  }
}

async function runChatTurn(prompt) {
  const options = {
    systemPrompt: CHAT_PROMPT,
    model: MODEL_ID,
    maxTurns: 4,
    tools: [],
    mcpServers: { observer: observerMcp },
    allowedTools: ['mcp__observer__query_gemini'],
    effort: 'low',
  };
  if (chatSessionId) options.resume = chatSessionId;

  const result = query({ prompt, options });

  let raw = '';
  let lastSessionId = null;
  for await (const msg of result) {
    if (msg.session_id) lastSessionId = msg.session_id;
    if (msg.type !== 'assistant') continue;
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        raw += block.text;
      } else if (block.type === 'tool_use' && block.name?.includes('query_gemini')) {
        const q = block.input?.question || '(no question captured)';
        await appendMessage({ role: 'system', text: `claude → gemini: ${q}` });
        await setStatus('claude is asking gemini…');
      }
    }
  }
  if (lastSessionId) chatSessionId = lastSessionId;
  return raw;
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

async function runGemini(arg) {
  const question = (arg || '').trim();

  if (!question) {
    const status = await checkGeminiDrawer();
    if (!status.open) {
      return appendMessage({
        role: 'system',
        text: 'Gemini drawer not detected. Open it in Meet (sparkles icon, top-right toolbar) and try /gemini again, or /gemini <question> to ask.',
      });
    }
    return appendMessage({
      role: 'system',
      text: `Gemini drawer detected.\n  drawer selector: ${status.drawerSelector}\n  input selector: ${status.inputSelector || '(not found)'}\nReady. Use: /gemini <question>`,
    });
  }

  if (busy) {
    return appendMessage({ role: 'system', text: 'Working on something — try again in a moment.' });
  }
  busy = true;
  await setStatus('asking gemini…');
  try {
    const status = await checkGeminiDrawer();
    if (!status.open) {
      await appendMessage({
        role: 'system',
        text: 'Gemini drawer is not open. Click the sparkles icon in Meet (top-right toolbar) to open it, then retry.',
      });
      return;
    }
    if (!status.hasInput) {
      await appendMessage({
        role: 'error',
        text: `Gemini drawer is open (${status.drawerSelector}) but no input field matched. Selectors may have drifted — DevTools the input and update GEMINI_SELECTORS.inputs.`,
      });
      return;
    }
    const result = await driveGemini(question);
    if (!result.ok) {
      await appendMessage({ role: 'error', text: `Gemini drive failed: ${result.error}` });
      return;
    }
    await appendMessage({ role: 'gemini', question, text: result.response });
  } catch (err) {
    await appendMessage({ role: 'error', text: `gemini error: ${err.message}` });
  } finally {
    busy = false;
    await setStatus('idle');
  }
}

async function checkGeminiDrawer() {
  return await page.evaluate((sel) => {
    const isVisible = (el) => !!(el && el.offsetWidth > 0 && el.offsetHeight > 0);
    let drawer = null;
    let drawerSelector = null;
    for (const s of sel.drawers) {
      const candidates = Array.from(document.querySelectorAll(s));
      const v = candidates.find(isVisible);
      if (v) { drawer = v; drawerSelector = s; break; }
    }
    if (!drawer) return { open: false };
    let input = null;
    let inputSelector = null;
    for (const s of sel.inputs) {
      const el = drawer.querySelector(s);
      if (isVisible(el)) { input = el; inputSelector = s; break; }
    }
    return {
      open: true,
      drawerSelector,
      inputSelector,
      hasInput: !!input,
    };
  }, GEMINI_SELECTORS);
}

async function driveGemini(question) {
  return await page.evaluate(async (q, sel) => {
    const isVisible = (el) => !!(el && el.offsetWidth > 0 && el.offsetHeight > 0);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    let drawer = null;
    for (const s of sel.drawers) {
      const v = Array.from(document.querySelectorAll(s)).find(isVisible);
      if (v) { drawer = v; break; }
    }
    if (!drawer) return { ok: false, error: 'drawer not found / not visible' };

    let input = null;
    for (const s of sel.inputs) {
      const el = drawer.querySelector(s);
      if (isVisible(el)) { input = el; break; }
    }
    if (!input) return { ok: false, error: 'input not found in drawer' };

    const snapBefore = drawer.innerText.length;

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = window.HTMLTextAreaElement.prototype === Object.getPrototypeOf(input)
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, q); else input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (input.isContentEditable) {
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, q);
    } else {
      return { ok: false, error: 'unsupported input type: ' + input.tagName };
    }
    input.focus();

    let submit = null;
    for (const s of sel.submits) {
      const el = drawer.querySelector(s);
      if (isVisible(el) && !el.disabled) { submit = el; break; }
    }
    if (submit) {
      submit.click();
    } else {
      const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(enterEvent);
    }

    const start = Date.now();
    const TIMEOUT_MS = 45000;
    const STABLE_MS = 1800;
    let lastLen = drawer.innerText.length;
    let lastChange = Date.now();
    while (Date.now() - start < TIMEOUT_MS) {
      await sleep(400);
      const cur = drawer.innerText.length;
      if (cur !== lastLen) {
        lastLen = cur;
        lastChange = Date.now();
        continue;
      }
      if (cur > snapBefore && Date.now() - lastChange > STABLE_MS) break;
    }

    const fullText = drawer.innerText;
    const newPart = fullText.slice(snapBefore).trim();
    if (!newPart) {
      return { ok: false, error: 'no new text appeared in drawer within timeout' };
    }
    return { ok: true, response: newPart };
  }, question, GEMINI_SELECTORS);
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
        'position:fixed;top:80px;right:20px;z-index:2147483647;width:360px;height:60vh;min-height:240px;max-height:90vh;display:flex;flex-direction:column;background:rgba(20,20,20,0.92);backdrop-filter:blur(10px);color:white;font:13px/1.4 system-ui,-apple-system,sans-serif;border-radius:10px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 32px rgba(0,0,0,0.5);pointer-events:auto;outline:none;overflow:hidden;');
      root.id = 'claude-observer-overlay';
      root.tabIndex = 0;

      // Restore saved position + size
      try {
        const saved = JSON.parse(localStorage.getItem('claude-observer-pos') || 'null');
        if (saved && typeof saved.left === 'string' && typeof saved.top === 'string') {
          root.style.left = saved.left;
          root.style.top = saved.top;
          root.style.right = 'auto';
        }
      } catch (e) { /* ignore */ }
      try {
        const savedSize = JSON.parse(localStorage.getItem('claude-observer-size') || 'null');
        if (savedSize && savedSize.width && savedSize.height) {
          root.style.width = savedSize.width;
          root.style.height = savedSize.height;
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
        'flex:1 1 0;min-height:0;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:8px;');
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
        const isGemini = role === 'gemini';

        const nudgeColor = msg.urgency === 'now' ? '#f97316' : '#9ca3af';
        const bg = isUser ? 'rgba(96,165,250,0.12)'
          : isNudge ? 'rgba(249,115,22,0.08)'
          : isGemini ? 'rgba(168,85,247,0.10)'
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
          isGemini ? 'border-left:3px solid #a855f7' : '',
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
        } else if (isGemini) {
          const tag = make('div',
            'font-size:10px;color:#a855f7;font-weight:600;letter-spacing:0.06em;margin-bottom:4px;',
            '✨ GEMINI');
          if (msg.question) {
            const q = make('div', 'font-size:11px;color:#d1d5db;margin-bottom:6px;font-style:italic;',
              `Q: ${msg.question}`);
            bubble.appendChild(tag);
            bubble.appendChild(q);
          } else {
            bubble.appendChild(tag);
          }
          const body = make('div', '', msg.text);
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

      // Resize handle (bottom-right corner)
      const resizer = make('div',
        'position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;z-index:1;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,0.25) 50%,rgba(255,255,255,0.25) 60%,transparent 60%,transparent 70%,rgba(255,255,255,0.25) 70%,rgba(255,255,255,0.25) 80%,transparent 80%);border-bottom-right-radius:10px;');
      root.appendChild(resizer);

      let resizing = false;
      let resizeStart = null;
      resizer.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const rect = root.getBoundingClientRect();
        resizing = true;
        resizeStart = { mx: e.clientX, my: e.clientY, w: rect.width, h: rect.height };
        e.preventDefault();
        e.stopPropagation();
      });

      const onMove = (e) => {
        if (dragging) {
          const dx = e.clientX - dragStart.mx;
          const dy = e.clientY - dragStart.my;
          const left = Math.max(0, Math.min(window.innerWidth - 80, dragStart.rx + dx));
          const top = Math.max(0, Math.min(window.innerHeight - 60, dragStart.ry + dy));
          root.style.left = left + 'px';
          root.style.top = top + 'px';
          root.style.right = 'auto';
        }
        if (resizing) {
          const dx = e.clientX - resizeStart.mx;
          const dy = e.clientY - resizeStart.my;
          const w = Math.max(280, Math.min(window.innerWidth - 40, resizeStart.w + dx));
          const h = Math.max(200, Math.min(window.innerHeight - 40, resizeStart.h + dy));
          root.style.width = w + 'px';
          root.style.height = h + 'px';
          root.style.maxHeight = 'none';
        }
      };
      const onUp = () => {
        if (dragging) {
          dragging = false;
          try {
            localStorage.setItem('claude-observer-pos', JSON.stringify({
              left: root.style.left, top: root.style.top,
            }));
          } catch (e) { /* ignore */ }
        }
        if (resizing) {
          resizing = false;
          try {
            localStorage.setItem('claude-observer-size', JSON.stringify({
              width: root.style.width, height: root.style.height,
            }));
          } catch (e) { /* ignore */ }
        }
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
