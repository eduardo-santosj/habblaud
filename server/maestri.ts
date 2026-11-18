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

/** Um JSON { chave: texto } relido só quando o arquivo muda. Nunca lança; chaves em minúsculas. */
class JsonMap {
  private mtimeMs = -1;
  private map = new Map<string, string>();

  constructor(private file: string) {}

  get(key: string): string | undefined {
    this.refresh();
    return this.map.get(key.toLowerCase());
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
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) next.set(k.toLowerCase(), v.trim().slice(0, 60));
      }
      this.map = next;
      this.mtimeMs = mtimeMs;
    } catch {
      // leitura pela metade: tenta de novo na próxima
    }
  }
}

/** Nomes dos papéis (roles.json) e a área revisada à mão de cada um (areas.json, { "<uuid>": "<Área>" }). */
export class MaestriRoles {
  private names: JsonMap;
  private areas: JsonMap;

  constructor(usageDir: string) {
    this.names = new JsonMap(join(usageDir, 'maestri', 'roles.json'));
    this.areas = new JsonMap(join(usageDir, 'maestri', 'areas.json'));
  }

  name(roleId: string): string | undefined {
    return this.names.get(roleId);
  }

  area(roleId: string): string | undefined {
    return this.areas.get(roleId);
  }
}

// ------------------------------------------------------------------ salas por área (fork Vela)

/** As salas do escritório por área. */
export const AREAS = ['Coordenação', 'Front', 'Back', 'UI', 'QA', 'Infra', 'Segurança', 'Marketing', 'Geral'] as const;
export type Area = (typeof AREAS)[number];

const AREA_ALIASES: Record<string, Area> = {
  coordenacao: 'Coordenação', coord: 'Coordenação', maestro: 'Coordenação',
  front: 'Front', frontend: 'Front', web: 'Front', app: 'Front', mobile: 'Front',
  back: 'Back', backend: 'Back', api: 'Back',
  ui: 'UI', design: 'UI', ux: 'UI',
  qa: 'QA', teste: 'QA', testes: 'QA',
  infra: 'Infra', devops: 'Infra', deploy: 'Infra',
  seguranca: 'Segurança', sec: 'Segurança', security: 'Segurança',
  marketing: 'Marketing', mkt: 'Marketing', conteudo: 'Marketing',
  geral: 'Geral',
};

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** "QA", "Segurança", "seguranca", "frontend"... -> a área; undefined se não reconhecer. */
export function normalizeArea(v: string | undefined): Area | undefined {
  return v ? AREA_ALIASES[semAcento(v)] : undefined;
}

/** "[QA] Revisor Loja" -> { area: 'QA', name: 'Revisor Loja' }. Sem prefixo reconhecido, devolve só o nome. */
export function splitAreaPrefix(roleName: string): { area?: Area; name: string } {
  const m = /^\s*\[([^\]]+)\]\s*(.+)$/.exec(roleName);
  const area = m ? normalizeArea(m[1]) : undefined;
  return area && m ? { area, name: m[2].trim() } : { name: roleName.trim() };
}

/** Id (e caminho) da sala de uma área: "/areas/QA" -> a sala aparece como "QA". */
export function areaRoomId(area: string): string {
  return `/areas/${area}`;
}

export interface SessionPlacement {
  /** Sala onde o agente senta. */
  roomId: string;
  /** Nome do personagem, quando a sala decide (recruta do Maestri); senão, o sorteio de sempre. */
  name?: string;
}

export interface PathRoom {
  /** Trecho de caminho (pastas inteiras), ex.: "clientes/acme". */
  segment: string;
  room: string;
}

/**
 * HABBLAUD_PATH_ROOMS="clientes/acme=Acme;outro/repo=Outro": sessões diretas dentro dessas pastas ganham sala
 * própria (ex.: trabalho de um cliente separado do resto). Fica no .env local, fora do repositório.
 */
export function parsePathRooms(v: string | undefined): PathRoom[] {
  return (v ?? '')
    .split(';')
    .map((item) => {
      const i = item.lastIndexOf('=');
      const segment = i > 0 ? item.slice(0, i).trim().replace(/^[\\/]+|[\\/]+$/g, '') : '';
      const room = i > 0 ? item.slice(i + 1).trim() : '';
      return { segment, room };
    })
    .filter((r) => r.segment && r.room);
}

function insidePath(cwd: string, segment: string): boolean {
  const norm = (s: string) => `/${s.replace(/[\\/]+/g, '/').toLowerCase().replace(/^\/|\/$/g, '')}/`;
  return norm(cwd).includes(norm(segment));
}

/**
 * Onde senta cada sessão no modo por área:
 * - recruta do Maestri: área do prefixo do nome, senão a da tabela revisada, senão Geral; nome sem o prefixo;
 * - sessão direta numa pasta de HABBLAUD_PATH_ROOMS: a sala configurada para ela;
 * - qualquer outra sessão direta: Coordenação (é o dono ou o Maestro coordenando).
 */
export function placeByArea(cwd: string, roles: Pick<MaestriRoles, 'name' | 'area'> | undefined, pathRooms: readonly PathRoom[] = []): SessionPlacement {
  const recruta = parseMaestriRoleCwd(cwd);
  if (recruta) {
    const full = roles?.name(recruta.roleId) ?? `Maestri ${recruta.roleId.slice(0, 8)}`;
    const { area: prefixed, name } = splitAreaPrefix(full);
    const area = prefixed ?? normalizeArea(roles?.area(recruta.roleId)) ?? 'Geral';
    return { roomId: areaRoomId(area), name };
  }
  const own = pathRooms.find((r) => insidePath(cwd, r.segment));
  if (own) return { roomId: areaRoomId(own.room) };
  return { roomId: areaRoomId('Coordenação') };
}
