import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, 'templates');

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2] };
}

export function loadTemplates(dir = TEMPLATES_DIR) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name || f.replace(/\.md$/, '')).toLowerCase();
    map.set(name, {
      name,
      description: meta.description || '',
      prompt: body.trim(),
    });
  }
  return map;
}

export function listTemplateNames(map) {
  return Array.from(map.keys()).join(', ');
}
