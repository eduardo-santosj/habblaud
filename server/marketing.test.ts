import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarketingService } from './marketing';

function montar() {
  const usage = mkdtempSync(join(tmpdir(), 'mkt-'));
  const pauta = join(usage, 'marketing', 'pauta');
  mkdirSync(pauta, { recursive: true });
  const item = (id: string, dia: string) => ({ id, conta: 'loja', dia, formato: 'post', tema: 'T', legenda: 'L', status: 'proposta' });
  writeFileSync(join(pauta, '2026-11-09.json'), JSON.stringify({ semana: '2026-11-09', geradaEm: 'x', itens: [item('velho', '2026-11-10')] }));
  writeFileSync(join(pauta, '2026-11-23.json'), JSON.stringify({ semana: '2026-11-23', geradaEm: 'x', itens: [item('a', '2026-11-24'), item('b', '2026-11-26')] }));
  writeFileSync(join(pauta, 'lixo.json'), '{');
  return { usage, pauta, svc: new MarketingService(usage) };
}

describe('MarketingService', () => {
  const agora = Date.parse('2026-11-18T15:00:00Z');

  it('mostra só a semana atual em diante e conta as propostas', () => {
    const { svc } = montar();
    const s = svc.snapshot(agora);
    expect(s.pautas.map((p) => p.semana)).toEqual(['2026-11-23']);
    expect(s.pendentes).toBe(2);
    expect(s.configurado).toBe(false);
    expect(s.metricas).toBeNull();
  });

  it('grava a decisão no arquivo da semana', () => {
    const { svc, pauta } = montar();
    svc.decidir('2026-11-23', 'a', 'aprovado');
    const arq = JSON.parse(readFileSync(join(pauta, '2026-11-23.json'), 'utf8'));
    expect(arq.itens[0].status).toBe('aprovado');
    expect(svc.snapshot(agora).pendentes).toBe(1);
  });

  it('recusa semana fora do formato (sem caminho relativo) e pauta inexistente', () => {
    const { svc } = montar();
    expect(() => svc.decidir('../../etc', 'a', 'aprovado')).toThrow(/semana inválida/);
    expect(() => svc.decidir('2026-12-07', 'a', 'aprovado')).toThrow(/não encontrada/);
    expect(() => svc.decidir('2026-11-23', 'a', 'publicado')).toThrow(/inválido/);
  });
});
