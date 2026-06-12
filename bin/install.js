#!/usr/bin/env node
// Copies the backend-foundation skill into the current project's .claude/skills/
// Usage:  npx backend-foundation init        → ./.claude/skills/backend-foundation
//         npx backend-foundation init --user → ~/.claude/skills/backend-foundation
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'skills', 'backend-foundation');

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd !== 'init') {
    console.log('Usage: npx backend-foundation init [--user]');
    console.log('  init         copy the skill into ./.claude/skills/backend-foundation');
    console.log('  init --user  copy the skill into ~/.claude/skills/backend-foundation (all projects)');
    process.exit(cmd ? 1 : 0);
}

const base = args.includes('--user') ? os.homedir() : process.cwd();
const DEST = path.join(base, '.claude', 'skills', 'backend-foundation');

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true });
console.log(`✅ Skill installed: ${DEST}`);
console.log('Claude Code picks it up automatically. Try: "scaffold a new backend using the backend-foundation skill"');
