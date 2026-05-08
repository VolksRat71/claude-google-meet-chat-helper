import fs from 'fs';
import { z } from 'zod';

export const CONFIG_FILE = './.observer-config.json';

export const ConfigSchema = z.object({
  modelId: z.string().default('opus'),
  nudgeIntervalMs: z.number().int().min(10_000).default(3 * 60 * 1000),
  autoNudgeOn: z.boolean().default(true),
  notesTemplate: z.string().default('workflow'),
  geminiAugment: z.boolean().default(false),
  overlay: z.object({
    collapseOlderThanMs: z.number().int().min(0).default(2 * 60 * 1000),
  }).default({ collapseOlderThanMs: 2 * 60 * 1000 }),
});

export function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      raw = {};
    }
  }
  return ConfigSchema.parse(raw);
}

export function saveConfig(config) {
  const validated = ConfigSchema.parse(config);
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  return validated;
}
