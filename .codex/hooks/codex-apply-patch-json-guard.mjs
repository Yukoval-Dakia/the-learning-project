#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readStdin = () =>
  new Promise((resolveRead) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolveRead(data));
  });

const deny = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
};

const repoPath = (path) => resolve(process.cwd(), path);
const isJsonPath = (path) => path.endsWith('.json');

const splitOriginal = (content) => {
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
};

const findSequence = (haystack, needle, start) => {
  if (needle.length === 0) return start;
  for (let i = start; i <= haystack.length - needle.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
};

const sectionsFromPatch = (patch) => {
  const lines = patch.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const add = line.match(/^\*\*\* Add File: (.+)$/);
    const update = line.match(/^\*\*\* Update File: (.+)$/);
    const del = line.match(/^\*\*\* Delete File: (.+)$/);

    if (add || update || del) {
      current = {
        type: add ? 'add' : update ? 'update' : 'delete',
        path: (add || update || del)[1],
        lines: [],
      };
      sections.push(current);
      continue;
    }

    if (line.startsWith('*** ') && !line.startsWith('*** End of File')) {
      current = null;
      continue;
    }

    if (current) current.lines.push(line);
  }

  return sections;
};

const addedContent = (section) =>
  `${section.lines
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1))
    .join('\n')}\n`;

const simulatedUpdate = (section) => {
  let current;
  try {
    current = splitOriginal(readFileSync(repoPath(section.path), 'utf8'));
  } catch {
    return null;
  }

  let cursor = 0;
  let i = 0;
  while (i < section.lines.length) {
    if (!section.lines[i].startsWith('@@')) {
      i += 1;
      continue;
    }

    i += 1;
    const oldBlock = [];
    const newBlock = [];
    while (i < section.lines.length && !section.lines[i].startsWith('@@')) {
      const line = section.lines[i];
      const marker = line[0];
      if (marker === ' ' || marker === '-') oldBlock.push(line.slice(1));
      if (marker === ' ' || marker === '+') newBlock.push(line.slice(1));
      i += 1;
    }

    const pos = findSequence(current, oldBlock, cursor);
    if (pos === -1) return null;
    current.splice(pos, oldBlock.length, ...newBlock);
    cursor = pos + newBlock.length;
  }

  return `${current.join('\n')}\n`;
};

const main = async () => {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }

  if (event?.tool_name !== 'apply_patch') process.exit(0);
  const command = event?.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  for (const section of sectionsFromPatch(command)) {
    if (!isJsonPath(section.path) || section.type === 'delete') continue;

    const next = section.type === 'add' ? addedContent(section) : simulatedUpdate(section);
    if (next === null) continue;

    try {
      JSON.parse(next);
    } catch (err) {
      deny(`Refusing patch that would make invalid JSON in ${section.path}: ${err.message}`);
    }
  }
};

main().catch(() => process.exit(0));
