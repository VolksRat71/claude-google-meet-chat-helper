import puppeteer from 'puppeteer';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import { EventEmitter } from 'events';
import { loadState, saveState, rehydrateTranscript, findResumeCandidate } from './state.js';
import { loadConfig, saveConfig } from './config.js';
import { loadTemplates, listTemplateNames } from './templates.js';
import { startTui } from './tui.js';

const SESSION_FILE = '.observer-session';
const NOTES_CHUNK_CAP = 300;
const STATUS_INTERVAL_MS = 30 * 1000;
const SCRAPE_INTERVAL_MS = 3000;

let config = loadConfig();
const templates = loadTemplates();
if (!templates.has(config.notesTemplate)) {
  config.notesTemplate = templates.has('workflow') ? 'workflow' : (templates.keys().next().value || 'workflow');
}

const RESUME_ENV = process.env.RESUME_TRANSCRIPT;
let TRANSCRIPT_FILE;
let NOTES_FILE;

if (RESUME_ENV && fs.existsSync(RESUME_ENV)) {
  TRANSCRIPT_FILE = RESUME_ENV;
} else if (process.env.RESUME_LATEST === '1') {
  TRANSCRIPT_FILE = findResumeCandidate() || `transcript-${Date.now()}.jsonl`;
} else {
  TRANSCRIPT_FILE = `transcript-${Date.now()}.jsonl`;
}

const seen = new Set();
const transcript = [];
let lastNudgeIndex = 0;
let lastNotesIndex = 0;
let lastNotesAt = null;
let lastNudgeAt = null;
let nextNudgeAt = null;

const existingState = loadState(TRANSCRIPT_FILE);
if (existingState && fs.existsSync(TRANSCRIPT_FILE)) {
  const { transcript: rehydrated, seen: rehydratedSeen } = rehydrateTranscript(TRANSCRIPT_FILE);
  for (const e of rehydrated) transcript.push(e);
  for (const k of rehydratedSeen) seen.add(k);
  lastNotesIndex = Math.min(existingState.lastNotesIndex || 0, transcript.length);
  lastNudgeIndex = Math.min(existingState.lastNudgeIndex || 0, transcript.length);
  lastNotesAt = existingState.lastNotesAt || null;
  lastNudgeAt = existingState.lastNudgeAt || null;
  NOTES_FILE = existingState.notesFile && fs.existsSync(existingState.notesFile)
    ? existingState.notesFile
    : `notes-${Date.now()}.md`;
} else {
  NOTES_FILE = `notes-${Date.now()}.md`;
}

let lastStatusCount = transcript.length;
let overlayAttachCount = 0;
let nudgeTimer = null;
let busy = false;
let welcomeShown = false;
let scrapingStarted = false;
let chatSessionId = null;
try {
  if (fs.existsSync(SESSION_FILE)) {
    const saved = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (saved) chatSessionId = saved;
  }
} catch {
  // ignore
}

const bus = new EventEmitter();

function log(kind, text) {
  bus.emit('log', { kind, text, t: Date.now() });
}

function emitStats() {
  bus.emit('stats', {
    captions: transcript.length,
    lastNudgeAt,
    lastNotesAt,
    nextNudgeAt,
    autoNudgeOn: config.autoNudgeOn,
    intervalMs: config.nudgeIntervalMs,
    notesTemplate: config.notesTemplate,
    geminiAugment: config.geminiAugment,
    transcriptFile: TRANSCRIPT_FILE,
    notesFile: NOTES_FILE,
    busy,
    scrapingStarted,
  });
}

function persistState() {
  try {
    saveState(TRANSCRIPT_FILE, {
      transcriptFile: TRANSCRIPT_FILE,
      notesFile: NOTES_FILE,
      lastNotesIndex,
      lastNudgeIndex,
      lastNotesAt,
      lastNudgeAt,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    log('error', `state persist failed: ${err.message}`);
  }
}

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
- A /notes command writes notes-<ts>.md, a markdown synthesis of the workflow so far. That is also a separate peer instance of you with its own prompt. Templates available: ${listTemplateNames(templates)}.
- You have a tool called query_gemini. Gemini-in-Meet has the FULL meeting context — its own transcript, participants, chat, metadata — which is richer than the partial caption window you have. Use query_gemini when:
  - The captions don't include the context you'd need to answer well.
  - You'd otherwise be guessing.
  - The user explicitly asks you to consult Gemini.
  Do NOT use it for every message. Each call takes 5-15 seconds and is visible to the user. Default to answering from the transcript and your own knowledge when you reasonably can. Frame your Gemini questions specifically — Gemini has the full meeting, leverage that.
  The drawer auto-opens if it is closed; you no longer need to ask the user to open it.
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

function helpText() {
  const tnames = listTemplateNames(templates);
  return `Commands:
  /nudge              force a nudge from recent captions
  /notes [template]   refresh notes-*.md (templates: ${tnames})
  /interval N         set auto-nudge interval (seconds, min 10)
  /auto on|off        toggle auto-nudge
  /template <name>    set default notes template
  /augment on|off     toggle Gemini-augmented notes
  /gemini             report Gemini drawer status
  /gemini <q>         ask Gemini-in-Meet (auto-opens drawer)
  /clear              reset chat memory
  /help               this list
  /quit               end and dump final-*.json

Free text → chat with Claude.

Hotkeys (overlay focused, input empty):
  n=nudge  o=notes  t=type  ?=help  Esc=blur`;
}

const GEMINI_SELECTORS = {
  openButtons: [
    'button[aria-label*="Gemini" i]',
    'button[aria-label*="Companion" i]',
    'button[aria-label*="Take notes with Gemini" i]',
    '[role="button"][aria-label*="Gemini" i]',
  ],
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
  'Ask Gemini-in-Meet a question via the Workspace side drawer. Gemini has the full Meet context (its own transcript, participants, chat, metadata), which is richer than the partial caption window you have. Use only when the transcript is not enough; calls take 5-15 seconds. The drawer auto-opens if it is closed. Returns Gemini\'s text response.',
  { question: z.string().describe('The question to ask Gemini. Be specific — Gemini has the full meeting, so leverage that.') },
  async ({ question }) => {
    const result = await geminiAsk(question);
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

const tuiHandle = startTui({
  bus,
  onCommand: handleTuiCommand,
  onConfigChange: handleConfigChange,
  initial: snapshotState(),
});

if (chatSessionId) {
  log('info', `Resuming prior chat session ${chatSessionId.slice(0, 8)}…`);
}
if (existingState) {
  log('info', `Resumed transcript ${TRANSCRIPT_FILE} (${transcript.length} lines, lastNotesIndex=${lastNotesIndex}, lastNudgeIndex=${lastNudgeIndex}).`);
}
log('info', 'Log into Google and join the Meet, then press [s] in this TUI when captions are ON.');
emitStats();

function snapshotState() {
  return {
    config,
    templates: Array.from(templates.values()).map(t => ({ name: t.name, description: t.description })),
    transcriptFile: TRANSCRIPT_FILE,
    notesFile: NOTES_FILE,
    lastNotesIndex,
    lastNudgeIndex,
    captions: transcript.length,
    scrapingStarted,
    busy,
  };
}

async function handleTuiCommand(cmd) {
  switch (cmd.type) {
    case 'start':
      return startScraping();
    case 'nudge':
      return runNudge({ source: 'tui' });
    case 'notes':
      return runNotes({ template: cmd.template });
    case 'gemini':
      return runGemini(cmd.question || '');
    case 'quit':
      return endSession();
    default:
      log('error', `Unknown TUI command: ${cmd.type}`);
  }
}

function handleConfigChange(next) {
  const prev = config;
  config = saveConfig({ ...config, ...next });
  if (prev.nudgeIntervalMs !== config.nudgeIntervalMs || prev.autoNudgeOn !== config.autoNudgeOn) {
    startAutoNudge();
  }
  if (prev.notesTemplate !== config.notesTemplate && !templates.has(config.notesTemplate)) {
    log('error', `Template "${config.notesTemplate}" not found. Available: ${listTemplateNames(templates)}.`);
    config = saveConfig({ ...config, notesTemplate: prev.notesTemplate });
  }
  bus.emit('config', config);
  emitStats();
}

async function startScraping() {
  if (scrapingStarted) {
    log('system', 'Already scraping.');
    return;
  }
  scrapingStarted = true;
  log('info', `Capture started. Transcript → ${TRANSCRIPT_FILE}.`);
  log('info', `Auto-nudge ${config.autoNudgeOn ? 'every ' + (config.nudgeIntervalMs / 1000) + 's' : 'OFF'}.`);
  setInterval(scrapeOnce, SCRAPE_INTERVAL_MS);
  setInterval(printStatus, STATUS_INTERVAL_MS);
  startAutoNudge();
  emitStats();
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
    log('error', `scrape error: ${err.message}`);
  }
  await injectOverlay();
}

function printStatus() {
  const total = transcript.length;
  const delta = total - lastStatusCount;
  lastStatusCount = total;
  log('info', `${total} captions (+${delta}) | ${config.autoNudgeOn ? 'auto-nudge ' + (config.nudgeIntervalMs / 1000) + 's' : 'auto-nudge OFF'}`);
  emitStats();
}

function startAutoNudge() {
  if (nudgeTimer) clearInterval(nudgeTimer);
  nudgeTimer = null;
  nextNudgeAt = null;
  if (!config.autoNudgeOn || !scrapingStarted) {
    emitStats();
    return;
  }
  nextNudgeAt = Date.now() + config.nudgeIntervalMs;
  nudgeTimer = setInterval(() => {
    nextNudgeAt = Date.now() + config.nudgeIntervalMs;
    runNudge({ silent: true, source: 'auto' });
    emitStats();
  }, config.nudgeIntervalMs);
  emitStats();
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
    return dispatchCommand(cmdRaw.toLowerCase(), rest.join(' '));
  }

  return askClaude(text);
}

async function dispatchCommand(cmd, arg) {
  switch (cmd) {
    case 'help':
    case '?':
      return appendMessage({ role: 'system', text: helpText() });

    case 'nudge':
    case 'n':
      return runNudge({ source: 'manual' });

    case 'notes':
    case 'o': {
      const tplName = (arg || '').trim().toLowerCase();
      if (tplName && !templates.has(tplName)) {
        return appendMessage({ role: 'system', text: `Template "${tplName}" not found. Available: ${listTemplateNames(templates)}.` });
      }
      return runNotes({ template: tplName || config.notesTemplate });
    }

    case 'template': {
      const name = (arg || '').trim().toLowerCase();
      if (!name) {
        return appendMessage({ role: 'system', text: `Default template: ${config.notesTemplate}. Available: ${listTemplateNames(templates)}.` });
      }
      if (!templates.has(name)) {
        return appendMessage({ role: 'system', text: `Template "${name}" not found. Available: ${listTemplateNames(templates)}.` });
      }
      handleConfigChange({ notesTemplate: name });
      return appendMessage({ role: 'system', text: `Default template set to "${name}".` });
    }

    case 'augment': {
      const a = arg.toLowerCase();
      if (a !== 'on' && a !== 'off') {
        return appendMessage({ role: 'system', text: 'Usage: /augment on|off' });
      }
      handleConfigChange({ geminiAugment: a === 'on' });
      return appendMessage({ role: 'system', text: `Gemini-augmented notes ${a.toUpperCase()}.` });
    }

    case 'gemini':
    case 'g':
      return runGemini(arg);

    case 'interval': {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 10) {
        return appendMessage({ role: 'system', text: 'Usage: /interval <seconds>. Minimum 10.' });
      }
      handleConfigChange({ nudgeIntervalMs: n * 1000 });
      return appendMessage({ role: 'system', text: `Auto-nudge interval set to ${n}s.` });
    }

    case 'auto': {
      const a = arg.toLowerCase();
      if (a !== 'on' && a !== 'off') {
        return appendMessage({ role: 'system', text: 'Usage: /auto on|off' });
      }
      handleConfigChange({ autoNudgeOn: a === 'on' });
      return appendMessage({ role: 'system', text: a === 'on' ? `Auto-nudge ON, every ${config.nudgeIntervalMs / 1000}s.` : 'Auto-nudge OFF.' });
    }

    case 'clear':
      chatSessionId = null;
      try { fs.unlinkSync(SESSION_FILE); } catch { /* ignore */ }
      return appendMessage({ role: 'system', text: 'Chat memory cleared. Next message starts a fresh conversation.' });

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
  emitStats();
  try {
    const recent = transcript.slice(-30).map(e => `${e.speaker}: ${e.text}`).join('\n');
    const prompt = `Latest transcript window (this is the current snapshot — earlier turns may overlap):\n---\n${recent || '(no captions yet)'}\n---\n\nFacilitator: ${userText}`;
    const result = await runChatTurn(prompt);
    await appendMessage({ role: 'assistant', text: (result || '').trim() || '(empty response)' });
  } catch (err) {
    if (chatSessionId && /resume|session/i.test(err.message)) {
      chatSessionId = null;
      await appendMessage({ role: 'error', text: `chat error (cleared session, try again): ${err.message}` });
    } else {
      await appendMessage({ role: 'error', text: `chat error: ${err.message}` });
    }
  } finally {
    busy = false;
    await setStatus('idle');
    emitStats();
  }
}

async function runChatTurn(prompt) {
  const options = {
    systemPrompt: CHAT_PROMPT,
    model: config.modelId,
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
  if (lastSessionId) {
    chatSessionId = lastSessionId;
    try { fs.writeFileSync(SESSION_FILE, lastSessionId); } catch { /* non-fatal */ }
  }
  return raw;
}

async function runNudge({ silent = false, source = 'manual' } = {}) {
  if (busy) {
    if (!silent) await appendMessage({ role: 'system', text: 'Working on something — try again in a moment.' });
    return;
  }
  busy = true;
  await setStatus(source === 'auto' ? 'auto-nudge…' : 'nudging…');
  emitStats();
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
    lastNudgeAt = new Date().toISOString();
    persistState();
    log('info', `nudge [${parsed.urgency}] ${parsed.text}`);
    await appendMessage({ role: 'nudge', urgency: parsed.urgency, text: parsed.text });
  } catch (err) {
    await appendMessage({ role: 'error', text: `nudge error: ${err.message}` });
  } finally {
    busy = false;
    await setStatus('idle');
    emitStats();
  }
}

async function runNotes({ template } = {}) {
  if (busy) {
    return appendMessage({ role: 'system', text: 'Working on something — try again in a moment.' });
  }
  busy = true;
  const tplName = template || config.notesTemplate;
  const tpl = templates.get(tplName) || templates.get('workflow');
  if (!tpl) {
    busy = false;
    return appendMessage({ role: 'error', text: 'No templates found in templates/ directory.' });
  }
  await setStatus(`writing notes (${tpl.name})…`);
  emitStats();
  try {
    const newSlice = transcript.slice(lastNotesIndex);
    if (newSlice.length === 0 && fs.existsSync(NOTES_FILE)) {
      await appendMessage({ role: 'system', text: 'No new captions since last notes refresh.' });
      return;
    }
    const truncated = newSlice.length > NOTES_CHUNK_CAP;
    const sending = truncated ? newSlice.slice(-NOTES_CHUNK_CAP) : newSlice;
    const truncNote = truncated
      ? `\n(NOTE: ${newSlice.length - NOTES_CHUNK_CAP} older lines from this chunk were trimmed for length; integrate from the latest ${NOTES_CHUNK_CAP} below.)`
      : '';
    const newText = sending.length
      ? sending.map(e => `${e.speaker}: ${e.text}`).join('\n')
      : '(no new captions)';
    const previous = fs.existsSync(NOTES_FILE)
      ? fs.readFileSync(NOTES_FILE, 'utf8')
      : '(no previous notes — this is the first synthesis)';

    const claudePrompt = `Previous notes (your running synthesis so far):\n---\n${previous}\n---\n\nNew transcript since last refresh${truncNote}:\n---\n${newText}\n---\n\nUpdate the notes by integrating the new section. Preserve and refine the prior sections; do not drop earlier insight. Output the COMPLETE updated markdown doc, not a diff.`;

    let md;
    if (config.geminiAugment) {
      await setStatus('asking claude + gemini…');
      const geminiPrompt = `You are providing a second opinion on a workflow-discovery meeting. Following the template below, synthesize what you've observed in this meeting so far. Use the FULL meeting context you have access to (your transcript, participants, etc.) — your output will be merged with another model's pass.

Template:
${tpl.prompt}

Output the markdown doc only, no preamble or fences.`;

      const [claudeDraftRaw, geminiDraft] = await Promise.all([
        callClaude({ system: tpl.prompt, prompt: claudePrompt }),
        geminiAsk(geminiPrompt).then(r => r.ok ? r.response : `(gemini unavailable: ${r.error})`),
      ]);

      const mergePrompt = `Two models drafted notes for the same meeting. Merge them into one coherent doc that follows the template. Where they agree, deduplicate. Where they differ, keep the more specific / better-attributed version. Where one has detail the other misses, integrate it. Do not invent content. Output only the markdown doc, no preamble or fences.

--- Claude draft ---
${stripFences(claudeDraftRaw).trim()}

--- Gemini draft ---
${geminiDraft}`;
      const merged = await callClaude({ system: tpl.prompt, prompt: mergePrompt });
      md = stripFences(merged).trim() || stripFences(claudeDraftRaw).trim();
    } else {
      const raw = await callClaude({ system: tpl.prompt, prompt: claudePrompt });
      md = stripFences(raw).trim();
    }

    if (!md) {
      await appendMessage({ role: 'error', text: 'notes: empty response' });
      return;
    }
    fs.writeFileSync(NOTES_FILE, md);
    lastNotesIndex = transcript.length;
    lastNotesAt = new Date().toISOString();
    persistState();
    const wc = md.split(/\s+/).filter(Boolean).length;
    const trim = truncated ? ` (chunk trimmed: ${newSlice.length} → ${NOTES_CHUNK_CAP})` : '';
    const augTag = config.geminiAugment ? ' [gemini-augmented]' : '';
    await appendMessage({ role: 'system', text: `Notes refreshed (${tpl.name})${augTag} → ${NOTES_FILE} (${wc} words${trim}).` });
  } catch (err) {
    await appendMessage({ role: 'error', text: `notes error: ${err.message}` });
  } finally {
    busy = false;
    await setStatus('idle');
    emitStats();
  }
}

async function runGemini(arg) {
  const question = (arg || '').trim();
  if (!question) {
    const status = await checkGeminiDrawer();
    if (!status.open) {
      return appendMessage({ role: 'system', text: 'Gemini drawer not detected. Will auto-open on next /gemini <question>.' });
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
  emitStats();
  try {
    const result = await geminiAsk(question);
    if (!result.ok) {
      await appendMessage({ role: 'error', text: `Gemini failed: ${result.error}` });
      return;
    }
    await appendMessage({ role: 'gemini', question, text: result.response });
  } catch (err) {
    await appendMessage({ role: 'error', text: `gemini error: ${err.message}` });
  } finally {
    busy = false;
    await setStatus('idle');
    emitStats();
  }
}

// --- Gemini async wrapper -------------------------------------------------

let geminiQueue = Promise.resolve();
function geminiAsk(question, options = {}) {
  const next = geminiQueue.then(() => geminiAskImpl(question, options));
  geminiQueue = next.catch(() => {});
  return next;
}

async function geminiAskImpl(question, { autoOpen = true, timeoutMs = 45000 } = {}) {
  let status = await checkGeminiDrawer();
  if (!status.open && autoOpen) {
    const opened = await openGeminiDrawer();
    if (!opened.ok) return { ok: false, error: 'auto-open failed: ' + opened.error };
    status = await checkGeminiDrawer();
  }
  if (!status.open) return { ok: false, error: 'drawer not open' };
  if (!status.hasInput) return { ok: false, error: 'drawer has no input field; selectors may have drifted' };
  return await driveGemini(question, timeoutMs);
}

async function openGeminiDrawer() {
  const click = await page.evaluate((sel) => {
    const isVisible = (el) => !!(el && el.offsetWidth > 0 && el.offsetHeight > 0);
    for (const s of sel.openButtons) {
      const btn = Array.from(document.querySelectorAll(s)).find(isVisible);
      if (btn) {
        btn.click();
        return { ok: true, sel: s };
      }
    }
    return { ok: false, error: 'no Gemini button visible in toolbar' };
  }, GEMINI_SELECTORS);
  if (!click.ok) return click;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const s = await checkGeminiDrawer();
    if (s.open && s.hasInput) return { ok: true };
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok: false, error: 'drawer did not mount after click' };
}

async function checkGeminiDrawer() {
  return await page.evaluate((sel) => {
    const isVisible = (el) => !!(el && el.offsetWidth > 0 && el.offsetHeight > 0);
    let drawer = null;
    let drawerSelector = null;
    for (const s of sel.drawers) {
      const v = Array.from(document.querySelectorAll(s)).find(isVisible);
      if (v) { drawer = v; drawerSelector = s; break; }
    }
    if (!drawer) return { open: false };
    let input = null;
    let inputSelector = null;
    for (const s of sel.inputs) {
      const el = drawer.querySelector(s);
      if (isVisible(el)) { input = el; inputSelector = s; break; }
    }
    return { open: true, drawerSelector, inputSelector, hasInput: !!input };
  }, GEMINI_SELECTORS);
}

async function driveGemini(question, timeoutMs = 45000) {
  return await page.evaluate(async (q, sel, TIMEOUT_MS) => {
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
    if (!newPart) return { ok: false, error: 'no new text appeared in drawer within timeout' };
    return { ok: true, response: newPart };
  }, question, GEMINI_SELECTORS, timeoutMs);
}

async function callClaude({ system, prompt }) {
  const result = query({
    prompt,
    options: {
      systemPrompt: system,
      model: config.modelId,
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

// --- Overlay --------------------------------------------------------------

async function injectOverlay() {
  try {
    const result = await page.evaluate((collapseOlderThanMs) => {
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
      const clearChildren = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

      const root = make('div',
        'position:fixed;top:80px;right:20px;z-index:2147483647;width:360px;height:60vh;min-height:240px;max-height:90vh;display:flex;flex-direction:column;background:rgba(20,20,20,0.92);backdrop-filter:blur(10px);color:white;font:13px/1.4 system-ui,-apple-system,sans-serif;border-radius:10px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 12px 32px rgba(0,0,0,0.5);pointer-events:auto;outline:none;overflow:hidden;');
      root.id = 'claude-observer-overlay';
      root.tabIndex = 0;

      try {
        const saved = JSON.parse(localStorage.getItem('claude-observer-pos') || 'null');
        if (saved && typeof saved.left === 'string' && typeof saved.top === 'string') {
          root.style.left = saved.left;
          root.style.top = saved.top;
          root.style.right = 'auto';
        }
      } catch { /* ignore */ }
      try {
        const savedSize = JSON.parse(localStorage.getItem('claude-observer-size') || 'null');
        if (savedSize && savedSize.width && savedSize.height) {
          root.style.width = savedSize.width;
          root.style.height = savedSize.height;
        }
      } catch { /* ignore */ }

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

      const COLLAPSE_KEY = 'claude-observer-collapsed';
      const loadCollapsed = () => {
        try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
        catch { return new Set(); }
      };
      const saveCollapsed = (set) => {
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(set))); }
        catch { /* ignore */ }
      };
      const collapsedIds = loadCollapsed();
      // Cap stored ids to avoid unbounded growth
      if (collapsedIds.size > 500) {
        const arr = Array.from(collapsedIds).slice(-500);
        collapsedIds.clear();
        for (const x of arr) collapsedIds.add(x);
        saveCollapsed(collapsedIds);
      }
      window.__observerCollapseMs = collapseOlderThanMs;
      window.__observerMessages = new Map(); // id -> msg

      let msgCounter = 0;

      const previewOf = (msg) => {
        const txt = (msg.text || '').replace(/\s+/g, ' ').trim();
        if (txt.length <= 80) return txt;
        return txt.slice(0, 77) + '…';
      };

      const renderBubble = (bubble, msg, collapsed) => {
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

        bubble.style.cssText = [
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
          'cursor:pointer',
        ].filter(Boolean).join(';');

        clearChildren(bubble);

        const caret = make('span', 'opacity:0.5;font-size:10px;margin-right:4px;', collapsed ? '▶' : '▼');

        if (collapsed) {
          const line = make('div', 'display:flex;align-items:center;gap:4px;');
          line.appendChild(caret);
          const labelTxt = isNudge ? `nudge${msg.urgency ? ' [' + msg.urgency + ']' : ''}`
            : isGemini ? 'gemini'
            : isUser ? 'you'
            : isSys ? 'system'
            : isErr ? 'error'
            : 'claude';
          const label = make('span', 'font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;', labelTxt);
          const preview = make('span', 'opacity:0.75;', previewOf(msg));
          line.appendChild(label);
          line.appendChild(preview);
          bubble.appendChild(line);
          return;
        }

        const headerRow = make('div', 'display:flex;align-items:center;gap:4px;margin-bottom:4px;');
        headerRow.appendChild(caret);

        if (isNudge) {
          const tag = make('span', `font-size:10px;color:${nudgeColor};font-weight:600;letter-spacing:0.06em;`, '💡 ' + (msg.urgency || '').toUpperCase());
          headerRow.appendChild(tag);
        } else if (isGemini) {
          const tag = make('span', 'font-size:10px;color:#a855f7;font-weight:600;letter-spacing:0.06em;', '✨ GEMINI');
          headerRow.appendChild(tag);
        } else {
          const lblTxt = isUser ? 'you' : isSys ? 'system' : isErr ? 'error' : 'claude';
          const lbl = make('span', 'font-size:10px;color:#9ca3af;', lblTxt);
          headerRow.appendChild(lbl);
        }
        bubble.appendChild(headerRow);

        if (isGemini && msg.question) {
          const q = make('div', 'font-size:11px;color:#d1d5db;margin-bottom:6px;font-style:italic;', `Q: ${msg.question}`);
          bubble.appendChild(q);
        }
        const body = make('div', '', msg.text);
        bubble.appendChild(body);
      };

      window.__observerAppend = (msg) => {
        msgCounter += 1;
        const id = `m${msgCounter}-${Date.now()}`;
        const msgWithId = Object.assign({}, msg, { id, t: msg.t || Date.now() });
        window.__observerMessages.set(id, msgWithId);

        const bubble = document.createElement('div');
        bubble.dataset.msgId = id;
        bubble.dataset.t = String(msgWithId.t);
        bubble.dataset.role = msg.role;

        bubble.addEventListener('click', () => {
          if (window.getSelection()?.toString()) return;
          if (collapsedIds.has(id)) collapsedIds.delete(id);
          else collapsedIds.add(id);
          saveCollapsed(collapsedIds);
          renderBubble(bubble, msgWithId, collapsedIds.has(id));
        });

        renderBubble(bubble, msgWithId, collapsedIds.has(id));
        feed.appendChild(bubble);
        feed.scrollTop = feed.scrollHeight;
      };

      window.__observerStatus = (s) => { statusEl.textContent = s; };

      const ageOlder = () => {
        const ms = window.__observerCollapseMs || 0;
        if (ms <= 0) return;
        const cutoff = Date.now() - ms;
        const bubbles = feed.querySelectorAll('[data-msg-id]');
        let mutated = false;
        bubbles.forEach((b) => {
          const t = parseInt(b.dataset.t || '0', 10);
          const id = b.dataset.msgId;
          if (t && t < cutoff && !collapsedIds.has(id)) {
            collapsedIds.add(id);
            mutated = true;
            const msgRec = window.__observerMessages.get(id);
            if (msgRec) renderBubble(b, msgRec, true);
          }
        });
        if (mutated) saveCollapsed(collapsedIds);
      };
      setInterval(ageOlder, 30000);

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

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          const text = input.value;
          input.value = '';
          submitText(text);
        }
      }, true);

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

      let dragging = false;
      let dragStart = null;
      header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const rect = root.getBoundingClientRect();
        dragging = true;
        dragStart = { mx: e.clientX, my: e.clientY, rx: rect.left, ry: rect.top };
        e.preventDefault();
      });

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
            localStorage.setItem('claude-observer-pos', JSON.stringify({ left: root.style.left, top: root.style.top }));
          } catch { /* ignore */ }
        }
        if (resizing) {
          resizing = false;
          try {
            localStorage.setItem('claude-observer-size', JSON.stringify({ width: root.style.width, height: root.style.height }));
          } catch { /* ignore */ }
        }
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);

      return { attached: true };
    }, config.overlay.collapseOlderThanMs);

    if (result?.attached) {
      overlayAttachCount += 1;
      if (!welcomeShown) {
        welcomeShown = true;
        const resumeNote = chatSessionId ? ` Resuming prior chat (${chatSessionId.slice(0, 8)}…) — /clear to wipe.` : '';
        await appendMessage({ role: 'system', text: `Observer ready. Type a message, hit ? for help, or use hotkeys (n/o/t).${resumeNote}` });
        await setStatus('idle');
      }
    } else {
      try {
        await page.evaluate((ms) => { window.__observerCollapseMs = ms; }, config.overlay.collapseOlderThanMs);
      } catch { /* ignore */ }
    }
  } catch (err) {
    log('error', `overlay inject error: ${err.message}`);
  }
}

async function appendMessage(msg) {
  bus.emit('message', msg);
  try {
    await page.evaluate((msg) => {
      if (window.__observerAppend) window.__observerAppend(msg);
    }, msg);
  } catch (err) {
    log('error', `overlay append error: ${err.message}`);
  }
}

async function setStatus(s) {
  bus.emit('status', s);
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
  log('info', `Session ended. Writing ${transcript.length} entries to ${finalFile}.`);
  try {
    fs.writeFileSync(finalFile, JSON.stringify({
      transcript_file: TRANSCRIPT_FILE,
      notes_file: NOTES_FILE,
      ended_at: Date.now(),
      entry_count: transcript.length,
      transcript,
    }, null, 2));
    persistState();
  } catch (err) {
    log('error', `final dump error: ${err.message}`);
  }
  if (tuiHandle?.unmount) tuiHandle.unmount();
  process.exit(0);
}

function stripFences(s) {
  return s.replace(/^```(?:\w+)?\s*/i, '').replace(/```\s*$/i, '');
}
