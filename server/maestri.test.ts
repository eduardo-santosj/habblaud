import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeClaudeFromShim } from './claude-bin';
import { MaestriRoles, parseMaestriRoleCwd } from './maestri';

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
