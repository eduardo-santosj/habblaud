#!/usr/bin/env node
// Nomes dos recrutas do Maestri para o Habblaud (ver server/maestri.ts).
//
// Grava <HABBLAUD_USAGE_DIR ou ~/.habblaud/usage>/maestri/roles.json = { "<uuid>": "<nome do papel>" }.
//
// Dois jeitos de rodar, ambos no host (onde ficam as pastas dos projetos):
//   - hook SessionStart do Claude Code (stdin = JSON com `cwd`): anota só o recruta que acabou de abrir;
//   - `node scripts/maestri-roles.mjs --scan` (npm run maestri:roles): varre as sessões em ~/.claude/projects.
// Só lê o role.json de pastas `.maestri/roles/<uuid>`; nunca falha a sessão (sai 0 sempre).
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROLE_CWD = /[\\/]\.maestri[\\/]+roles[\\/]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]*$/i;
const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
const usageDir = process.env.HABBLAUD_USAGE_DIR?.trim() || join(home, '.habblaud', 'usage');
const outFile = join(usageDir, 'maestri', 'roles.json');

function readMap() {
  try {
    const data = JSON.parse(readFileSync(outFile, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Nome do papel da pasta do recruta; undefined se não for recruta ou não tiver role.json legível. */
function roleOf(cwd) {
  const m = ROLE_CWD.exec(String(cwd ?? '').trim());
  if (!m) return undefined;
  try {
    const role = JSON.parse(readFileSync(join(cwd, 'role.json'), 'utf8'));
    const name = typeof role?.name === 'string' ? role.name.trim() : '';
    return name ? { id: m[1].toLowerCase(), name } : undefined;
  } catch {
    return undefined;
  }
}

/** O cwd gravado numa sessão (as primeiras linhas do .jsonl já trazem). */
function cwdOfSessionDir(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  for (const f of files.slice(0, 3)) {
    const head = readFileSync(join(dir, f), 'utf8').slice(0, 64 * 1024).split('\n');
    for (const line of head) {
      try {
        const cwd = JSON.parse(line)?.cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // linha cortada: segue
      }
    }
  }
  return undefined;
}

function scan() {
  const found = [];
  const roots = [join(home, '.claude', 'projects')];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = readdirSync(root).filter((d) => /maestri-roles-[0-9a-f-]{36}$/i.test(d));
    } catch {
      continue;
    }
    for (const d of dirs) {
      const r = roleOf(cwdOfSessionDir(join(root, d)));
      if (r) found.push(r);
    }
  }
  return found;
}

function save(entries) {
  if (!entries.length) return 0;
  const map = readMap();
  let changed = 0;
  for (const { id, name } of entries) {
    if (map[id] !== name) {
      map[id] = name;
      changed++;
    }
  }
  if (!changed) return 0;
  mkdirSync(join(usageDir, 'maestri'), { recursive: true });
  // Grava num temporário e troca: o servidor nunca lê o arquivo pela metade.
  const tmp = `${outFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
  renameSync(tmp, outFile);
  return changed;
}

try {
  if (process.argv.includes('--scan')) {
    const found = scan();
    const changed = save(found);
    console.log(`maestri-roles: ${found.length} recrutas encontrados, ${changed} nomes novos ou alterados -> ${outFile}`);
  } else {
    let raw = '';
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => {
      try {
        const r = roleOf(JSON.parse(raw)?.cwd);
        if (r) save([r]);
      } catch {
        // payload estranho: nada a fazer
      }
      process.exit(0);
    });
  }
} catch {
  process.exit(0);
}
