// Terminais recrutados pelo Maestri (canvas de agentes). Cada recruta roda numa pasta própria,
// <projeto>/.maestri/roles/<uuid>, com um role.json que traz o nome do papel ("Construtor Front").
// Sem isto, cada recruta vira uma sala com o uuid no nome e um personagem de nome sorteado.
//
// O nome do papel chega por um arquivo pequeno, <usageDir>/maestri/roles.json ({ "<uuid>": "<nome>" }), escrito no
// host pelo scripts/maestri-roles.mjs (hook SessionStart do Claude Code). No Docker, a pasta de uso já é montada
// em /usage; a subpasta maestri/ não atrapalha o leitor de uso, que só olha os .json soltos.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROLE_CWD = /^(.*?)[\\/]+\.maestri[\\/]+roles[\\/]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]*$/i;

export interface MaestriRoleCwd {
  /** Pasta do projeto que recrutou (a sala onde o recruta senta). */
  projectPath: string;
  /** uuid do papel, em minúsculas (chave do roles.json). */
  roleId: string;
}

/** A pasta é de um recruta do Maestri? Devolve o projeto e o uuid; undefined se não for. */
export function parseMaestriRoleCwd(cwd: string | undefined): MaestriRoleCwd | undefined {
  const m = ROLE_CWD.exec((cwd ?? '').trim());
  if (!m || !m[1]) return undefined;
  return { projectPath: m[1], roleId: m[2].toLowerCase() };
}

/** Lê o roles.json sob demanda, relendo só quando o arquivo muda. Nunca lança. */
export class MaestriRoles {
  private file: string;
  private mtimeMs = -1;
  private names = new Map<string, string>();

  constructor(usageDir: string) {
    this.file = join(usageDir, 'maestri', 'roles.json');
  }

  name(roleId: string): string | undefined {
    this.refresh();
    return this.names.get(roleId.toLowerCase());
  }

  private refresh(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      return; // ainda não existe: fica com o que tinha
    }
    if (mtimeMs === this.mtimeMs) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!data || typeof data !== 'object') return;
      const next = new Map<string, string>();
      for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) next.set(id.toLowerCase(), v.trim().slice(0, 60));
      }
      this.names = next;
      this.mtimeMs = mtimeMs;
    } catch {
      // leitura pela metade: tenta de novo na próxima
    }
  }
}
