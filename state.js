import fs from 'fs';

export function statePath(transcriptFile) {
  return transcriptFile + '.state.json';
}

export function loadState(transcriptFile) {
  const p = statePath(transcriptFile);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(transcriptFile, state) {
  const p = statePath(transcriptFile);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

export function rehydrateTranscript(transcriptFile) {
  const transcript = [];
  const seen = new Set();
  if (!fs.existsSync(transcriptFile)) return { transcript, seen };
  const raw = fs.readFileSync(transcriptFile, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.text && entry.speaker) {
        transcript.push(entry);
        seen.add(`${entry.speaker}::${entry.text}`);
      }
    } catch {
      // skip malformed line
    }
  }
  return { transcript, seen };
}

export function findResumeCandidate(cwd = process.cwd()) {
  // Returns the most recent transcript-*.jsonl in cwd that has a sidecar, or null.
  const files = fs.readdirSync(cwd)
    .filter(f => /^transcript-\d+\.jsonl$/.test(f))
    .map(f => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files) {
    if (fs.existsSync(statePath(f))) return f;
  }
  return null;
}
