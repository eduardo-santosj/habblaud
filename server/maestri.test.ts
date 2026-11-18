import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeClaudeFromShim } from './claude-bin';
import { MaestriRoles, normalizeArea, parseMaestriRoleCwd, parsePathRooms, placeByArea, splitAreaPrefix } from './maestri';

const UUID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const tmp: string[] = [];
const mktmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-maestri-'));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseMaestriRoleCwd', () => {
  it('reconhece a pasta de recruta no Windows e devolve o projeto', () => {
    expect(parseMaestriRoleCwd(`C:\\laragon\\www\\meu-projeto\\.maestri\\roles\\${UUID.toUpperCase()}`)).toEqual({
      projectPath: 'C:\\laragon\\www\\meu-projeto',
      roleId: UUID,
    });
  });

  it('reconhece com barras normais e barra no fim', () => {
    expect(parseMaestriRoleCwd(`/home/x/proj/.maestri/roles/${UUID}/`)).toEqual({ projectPath: '/home/x/proj', roleId: UUID });
  });

  it('ignora pastas comuns e subpastas do recruta', () => {
    expect(parseMaestriRoleCwd('C:\\laragon\\www\\meu-projeto')).toBeUndefined();
    expect(parseMaestriRoleCwd(`/p/.maestri/roles/${UUID}/src`)).toBeUndefined();
    expect(parseMaestriRoleCwd(undefined)).toBeUndefined();
  });
});

describe('MaestriRoles', () => {
  it('lê o nome pelo uuid, sem diferenciar maiúsculas', () => {
    const dir = mktmp();
    mkdirSync(join(dir, 'maestri'));
    writeFileSync(join(dir, 'maestri', 'roles.json'), JSON.stringify({ [UUID]: 'Construtor Front' }));
    expect(new MaestriRoles(dir).name(UUID.toUpperCase())).toBe('Construtor Front');
  });

  it('sem arquivo ou com arquivo quebrado, devolve undefined sem lançar', () => {
    const dir = mktmp();
    expect(new MaestriRoles(dir).name(UUID)).toBeUndefined();
    mkdirSync(join(dir, 'maestri'));
    writeFileSync(join(dir, 'maestri', 'roles.json'), '{ quebrado');
    expect(new MaestriRoles(dir).name(UUID)).toBeUndefined();
  });
});

describe('nativeClaudeFromShim', () => {
  it('no Windows troca o claude.cmd do npm pelo claude.exe do pacote', () => {
    const dir = mktmp();
    const bin = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude.exe'), '');
    writeFileSync(join(dir, 'claude.cmd'), '');
    expect(nativeClaudeFromShim(join(dir, 'claude.cmd'), 'win32')).toBe(join(bin, 'claude.exe'));
  });

  it('mantém o atalho se não houver exe, e não mexe fora do Windows', () => {
    const dir = mktmp();
    writeFileSync(join(dir, 'claude.cmd'), '');
    expect(nativeClaudeFromShim(join(dir, 'claude.cmd'), 'win32')).toBe(join(dir, 'claude.cmd'));
    expect(nativeClaudeFromShim('/usr/local/bin/claude', 'linux')).toBe('/usr/local/bin/claude');
  });
});

describe('salas por área', () => {
  const roles = (name?: string, area?: string) => ({ name: () => name, area: () => area });
  const recruta = String.raw`C:\dev\meu-projeto\.maestri\roles` + '\\' + UUID;

  it('normaliza área com ou sem acento e apelidos', () => {
    expect(normalizeArea('seguranca')).toBe('Segurança');
    expect(normalizeArea(' QA ')).toBe('QA');
    expect(normalizeArea('frontend')).toBe('Front');
    expect(normalizeArea('financeiro')).toBeUndefined();
  });

  it('separa o prefixo [Área] do nome; prefixo desconhecido fica no nome', () => {
    expect(splitAreaPrefix('[QA] Revisor Loja')).toEqual({ area: 'QA', name: 'Revisor Loja' });
    expect(splitAreaPrefix('[xyz] Revisor')).toEqual({ name: '[xyz] Revisor' });
    expect(splitAreaPrefix('Revisor')).toEqual({ name: 'Revisor' });
  });

  it('recruta vai pela área do prefixo, com o nome sem prefixo', () => {
    expect(placeByArea(recruta, roles('[Back] Alicerce Loja', 'QA'))).toEqual({ roomId: '/areas/Back', name: 'Alicerce Loja' });
  });

  it('sem prefixo, vale a tabela revisada; sem nada, Geral', () => {
    expect(placeByArea(recruta, roles('Alicerce Loja', 'back'))).toEqual({ roomId: '/areas/Back', name: 'Alicerce Loja' });
    expect(placeByArea(recruta, roles('Alicerce Loja'))).toEqual({ roomId: '/areas/Geral', name: 'Alicerce Loja' });
  });

  it('sessão direta vai para Coordenação, e as de HABBLAUD_PATH_ROOMS para a sala configurada', () => {
    const extra = parsePathRooms('clientes/acme=Acme; =Vazio; sem-sala= ;outro=Outro');
    expect(extra).toEqual([{ segment: 'clientes/acme', room: 'Acme' }, { segment: 'outro', room: 'Outro' }]);
    expect(placeByArea(String.raw`C:\dev\loja`, roles(), extra)).toEqual({ roomId: '/areas/Coordenação' });
    expect(placeByArea(String.raw`C:\dev\clientes\acme\repo`, roles(), extra)).toEqual({ roomId: '/areas/Acme' });
    expect(placeByArea(String.raw`C:\dev\clientes\acmeltda`, roles(), extra)).toEqual({ roomId: '/areas/Coordenação' });
  });
});
