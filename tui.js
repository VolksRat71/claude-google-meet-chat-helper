// Ink-based TUI for settings + status. Falls back to plain console if ink is
// not installed or stdout is not a TTY.

import { createRequire } from 'node:module';
const requireCjs = createRequire(import.meta.url);

let inkMod = null;
let reactMod = null;
try {
  inkMod = requireCjs('ink');
  reactMod = requireCjs('react');
} catch {
  // ink / react not installed — TUI will fall back to console mode.
}

function consoleFallback({ bus, onCommand, initial }) {
  const out = (s) => process.stdout.write(s + '\n');
  out(`[observer] starting (TUI disabled — non-TTY or ink missing)`);
  out(`[observer] transcript=${initial.transcriptFile} notes=${initial.notesFile}`);
  out(`[observer] config: ${JSON.stringify(initial.config)}`);
  bus.on('log', (l) => out(`[${l.kind}] ${l.text}`));
  bus.on('message', (m) => out(`[msg:${m.role}] ${(m.text || '').slice(0, 200)}`));
  bus.on('status', (s) => out(`[status] ${s}`));

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    const line = data.toString().trim().toLowerCase();
    if (!line) return;
    if (line === 'start' || line === 's') onCommand({ type: 'start' });
    else if (line === 'quit' || line === 'q' || line === 'session over') onCommand({ type: 'quit' });
    else if (line === 'nudge' || line === 'n') onCommand({ type: 'nudge' });
    else if (line === 'notes' || line === 'o') onCommand({ type: 'notes' });
  });
  return { unmount: () => {} };
}

export function startTui(opts) {
  if (!process.stdout.isTTY || !inkMod || !reactMod) {
    return consoleFallback(opts);
  }
  return mountInk(opts, inkMod, reactMod);
}

function mountInk({ bus, onCommand, onConfigChange, initial }, ink, React) {
  const e = React.createElement;
  const { Box, Text, useInput, useApp, render } = ink;
  const { useEffect, useState } = React;

  function fmtMs(ms) {
    if (ms == null) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleTimeString();
    } catch { return iso; }
  }

  function App() {
    const [stats, setStats] = useState({
      captions: initial.captions || 0,
      scrapingStarted: initial.scrapingStarted || false,
      busy: initial.busy || false,
      autoNudgeOn: initial.config.autoNudgeOn,
      intervalMs: initial.config.nudgeIntervalMs,
      notesTemplate: initial.config.notesTemplate,
      geminiAugment: initial.config.geminiAugment,
      transcriptFile: initial.transcriptFile,
      notesFile: initial.notesFile,
      lastNotesAt: null,
      lastNudgeAt: null,
      nextNudgeAt: null,
    });
    const [logs, setLogs] = useState([]);
    const [status, setStatus] = useState('starting');
    const [config, setConfig] = useState(initial.config);
    const [showHelp, setShowHelp] = useState(false);
    const [now, setNow] = useState(Date.now());
    const { exit } = useApp();

    useEffect(() => {
      const onStats = (s) => setStats(s);
      const onLog = (l) => setLogs((prev) => [...prev.slice(-50), l]);
      const onStatus = (s) => setStatus(s);
      const onConfig = (c) => setConfig(c);
      const onMessage = (m) => setLogs((prev) => [...prev.slice(-50), {
        kind: 'msg', text: `[${m.role}] ${(m.text || '').slice(0, 160)}`, t: Date.now(),
      }]);
      bus.on('stats', onStats);
      bus.on('log', onLog);
      bus.on('status', onStatus);
      bus.on('config', onConfig);
      bus.on('message', onMessage);
      const tick = setInterval(() => setNow(Date.now()), 1000);
      return () => {
        bus.off('stats', onStats);
        bus.off('log', onLog);
        bus.off('status', onStatus);
        bus.off('config', onConfig);
        bus.off('message', onMessage);
        clearInterval(tick);
      };
    }, []);

    useInput((input, key) => {
      if (key.ctrl && input === 'c') { onCommand({ type: 'quit' }); exit(); return; }
      if (input === 'q') { onCommand({ type: 'quit' }); exit(); return; }
      if (input === 's' && !stats.scrapingStarted) { onCommand({ type: 'start' }); return; }
      if (input === 'n') { onCommand({ type: 'nudge' }); return; }
      if (input === 'o') { onCommand({ type: 'notes' }); return; }
      if (input === 'a') { onConfigChange({ autoNudgeOn: !config.autoNudgeOn }); return; }
      if (input === 'G') { onConfigChange({ geminiAugment: !config.geminiAugment }); return; }
      if (input === '?') { setShowHelp((v) => !v); return; }
      if (input === '+' || input === '=') {
        onConfigChange({ nudgeIntervalMs: config.nudgeIntervalMs + 30_000 });
        return;
      }
      if (input === '-' || input === '_') {
        onConfigChange({ nudgeIntervalMs: Math.max(10_000, config.nudgeIntervalMs - 30_000) });
        return;
      }
      if (input === 't') {
        const names = initial.templates.map((t) => t.name);
        if (names.length === 0) return;
        const i = names.indexOf(config.notesTemplate);
        const next = names[(i + 1) % names.length];
        onConfigChange({ notesTemplate: next });
        return;
      }
    });

    const eta = stats.nextNudgeAt ? Math.max(0, stats.nextNudgeAt - now) : null;

    const settingsRows = [
      ['model', config.modelId, ''],
      ['interval', `${Math.round(config.nudgeIntervalMs / 1000)}s`, ' (+/- to adjust)'],
      ['auto', config.autoNudgeOn ? 'ON' : 'OFF', ' (a to toggle)'],
      ['template', config.notesTemplate, ' (t to cycle)'],
      ['gemini augment', config.geminiAugment ? 'ON' : 'OFF', ' (G to toggle)'],
      ['collapse age', `${Math.round((config.overlay?.collapseOlderThanMs || 0) / 1000)}s`, ''],
    ];

    const statusBox = e(Box, {
      borderStyle: 'round',
      borderColor: stats.scrapingStarted ? 'green' : 'yellow',
      paddingX: 1,
      flexDirection: 'column',
    },
      e(Box, {},
        e(Text, { bold: true }, 'Claude Observer  '),
        e(Text, { color: stats.scrapingStarted ? 'green' : 'yellow' },
          stats.scrapingStarted ? '● CAPTURING' : '○ WAITING'),
        e(Text, { color: 'gray' }, '  '),
        e(Text, { color: 'cyan' }, status || 'idle'),
      ),
      e(Box, {},
        e(Text, { color: 'gray' }, 'captions: '),
        e(Text, {}, String(stats.captions)),
        e(Text, { color: 'gray' }, '  next nudge: '),
        e(Text, {}, eta != null ? fmtMs(eta) : '—'),
        e(Text, { color: 'gray' }, '  last nudge: '),
        e(Text, {}, fmtTime(stats.lastNudgeAt)),
        e(Text, { color: 'gray' }, '  last notes: '),
        e(Text, {}, fmtTime(stats.lastNotesAt)),
      ),
      e(Box, {},
        e(Text, { color: 'gray' }, 'transcript: '),
        e(Text, {}, stats.transcriptFile || '—'),
        e(Text, { color: 'gray' }, '  notes: '),
        e(Text, {}, stats.notesFile || '—'),
      ),
    );

    const settingsBox = e(Box, {
      borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexDirection: 'column', width: 40,
    },
      e(Text, { bold: true, color: 'cyan' }, 'Settings'),
      ...settingsRows.map(([label, value, hint], i) =>
        e(Box, { key: String(i) },
          e(Text, { color: 'gray' }, `${label.padEnd(15)}`),
          e(Text, { color: 'white' }, String(value)),
          e(Text, { color: 'gray' }, hint),
        )
      ),
    );

    const logTail = logs.slice(-15);
    const activityBox = e(Box, {
      borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexDirection: 'column', flexGrow: 1,
    },
      e(Text, { bold: true, color: 'cyan' }, 'Activity'),
      ...logTail.map((l, i) => {
        const color = l.kind === 'error' ? 'red' : l.kind === 'msg' ? 'white' : 'gray';
        return e(Text, { key: String(i), color }, l.text);
      }),
    );

    const hotkeysBox = e(Box, { paddingX: 1 },
      e(Text, { color: 'gray' },
        '[s]tart  [n]udge  [o]notes  [a]uto  [t]emplate  [G]augment  [+/-]interval  [?]help  [q]uit'),
    );

    const helpBox = showHelp ? e(Box, {
      borderStyle: 'round', borderColor: 'magenta', paddingX: 1, flexDirection: 'column',
    },
      e(Text, { bold: true, color: 'magenta' }, 'Keys'),
      e(Text, {}, 's = start scraping (after you join the Meet)'),
      e(Text, {}, 'n = trigger a nudge now'),
      e(Text, {}, 'o = refresh notes (uses current template)'),
      e(Text, {}, 'a = toggle auto-nudge'),
      e(Text, {}, 't = cycle notes template'),
      e(Text, {}, 'G = toggle Gemini-augmented notes'),
      e(Text, {}, '+ / - = adjust auto-nudge interval by 30s'),
      e(Text, {}, '? = toggle this help'),
      e(Text, {}, 'q = quit and dump final-*.json'),
      e(Text, { color: 'gray' }, 'In the Meet overlay: type freely to chat with Claude; / for commands.'),
    ) : null;

    return e(Box, { flexDirection: 'column' },
      statusBox,
      e(Box, { flexDirection: 'row' },
        settingsBox,
        e(Box, { flexDirection: 'column', flexGrow: 1, marginLeft: 1 },
          activityBox,
          helpBox,
        ),
      ),
      hotkeysBox,
    );
  }

  const instance = render(e(App));
  return { unmount: () => instance.unmount() };
}
