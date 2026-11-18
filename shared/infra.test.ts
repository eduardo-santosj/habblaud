import { describe, expect, it } from 'vitest';
import { decidirCor, gerarAlertas, lerMaquina, lerResposta, projetar, ratearCusto, totalDoPagador, type InfraCustoFile, type InfraStatusFile, type LinhaCusto } from './infra';

describe('semáforo', () => {
  it('máquina parada ou com checagem falhando é vermelho, não importa o sistema', () => {
    expect(decidirCor('parada', 'ok', 0)).toBe('vermelho');
    expect(decidirCor('problema', 'falha', 5)).toBe('vermelho');
  });

  it('máquina ok com sistema degradado é amarelo na hora', () => {
    expect(decidirCor('ok', 'degradado', 0)).toBe('amarelo');
  });

  it('uma falha isolada do sistema mantém a cor anterior; a segunda acende o amarelo', () => {
    expect(decidirCor('ok', 'falha', 1, 'verde')).toBe('verde');
    expect(decidirCor('ok', 'falha', 1)).toBe('verde');
    expect(decidirCor('ok', 'falha', 2, 'verde')).toBe('amarelo');
  });

  it('sem resposta da AWS: sistema ok fica verde; sistema caído 2x fica vermelho; sem nada, cinza', () => {
    expect(decidirCor('desconhecido', 'ok', 0)).toBe('verde');
    expect(decidirCor('desconhecido', 'falha', 2)).toBe('vermelho');
    expect(decidirCor('desconhecido', 'desconhecido', 0)).toBe('cinza');
  });

  it('lê o estado da máquina pelo que a AWS devolve', () => {
    expect(lerMaquina('running', 'ok', 'ok')).toBe('ok');
    expect(lerMaquina('running', 'impaired', 'ok')).toBe('problema');
    expect(lerMaquina('stopped')).toBe('parada');
    expect(lerMaquina(undefined)).toBe('desconhecido');
  });
});

describe('leitura do health', () => {
  it('formatos reais de resposta "ok"', () => {
    expect(lerResposta('health', 200, '{"success":true,"code":"SYSTEM_HEALTHY"}')).toBe('ok');
    expect(lerResposta('health', 200, '{"ok":true}')).toBe('ok');
    expect(lerResposta('health', 200, '{"status":"ok","db":"up"}')).toBe('ok');
    expect(lerResposta('health', 200, '{"status":"ok","checks":{"redis":{"ok":true},"db":{"ok":true}}}')).toBe('ok');
  });

  it('dependência fora é degradado (503 ou campo down no JSON)', () => {
    expect(lerResposta('health', 503, '{"status":"degraded","db":"down"}')).toBe('degradado');
    expect(lerResposta('health', 200, '{"status":"ok","db":"down"}')).toBe('degradado');
    expect(lerResposta('health', 200, '{"status":"ok","checks":{"redis":{"ok":false}}}')).toBe('degradado');
  });

  it('HTML numa rota de health, 404 ou 500 é falha', () => {
    expect(lerResposta('health', 200, '<!DOCTYPE html><html>')).toBe('falha');
    expect(lerResposta('health', 404, '<html>')).toBe('falha');
    expect(lerResposta('health', 500, '{"error":"x"}')).toBe('falha');
  });

  it('modo site: 2xx e 3xx (redirecionar pro login) contam como no ar', () => {
    expect(lerResposta('site', 200, '<html>')).toBe('ok');
    expect(lerResposta('site', 307, '')).toBe('ok');
    expect(lerResposta('site', 502, '')).toBe('falha');
  });
});

describe('rateio do custo', () => {
  // Uma fatura real de um mês (US$ 147,82): conta 111 com 3 máquinas (2 pequenas e 1 média) e o imposto da fatura
  // inteira; conta 222 (mesma fatura) com um produto só.
  const linhas: LinhaCusto[] = [
    { mes: '2026-10', conta: '111', servico: 'Amazon Elastic Compute Cloud - Compute', valor: 61.9 },
    { mes: '2026-10', conta: '111', servico: 'Amazon Virtual Private Cloud', valor: 11.16 },
    { mes: '2026-10', conta: '111', servico: 'EC2 - Other', valor: 7.21 },
    { mes: '2026-10', conta: '111', servico: 'Tax', valor: 11.11 },
    { mes: '2026-10', conta: '222', servico: 'Amazon Elastic Compute Cloud - Compute', valor: 40 },
    { mes: '2026-10', conta: '222', servico: 'AWS Secrets Manager', valor: 16.43 },
  ];
  const grupos = [
    { grupo: 'a', conta: '111', peso: 0.0208 },
    { grupo: 'b', conta: '111', peso: 0.0208 },
    { grupo: 'c', conta: '111', peso: 0.0416 },
    { grupo: 'd', conta: '222', peso: 0.0336 },
  ];
  const r = ratearCusto(linhas, grupos, () => 'fatura-1').get('2026-10')!;

  it('máquina divide pelo tamanho, IP e disco dividem igual, e o imposto incide sobre a fatura toda', () => {
    expect(r.a).toBeCloseTo(23.35, 1);
    expect(r.b).toBeCloseTo(23.35, 1);
    expect(r.c).toBeCloseTo(40.09, 1);
    expect(r.d).toBeCloseTo(61.02, 1);
  });

  it('a soma dos grupos fecha com a fatura', () => {
    expect(Object.values(r).reduce((s, v) => s + v, 0)).toBeCloseTo(147.81, 1);
  });

  it('conta sem grupo cadastrado vai para "outros"', () => {
    const x = ratearCusto([{ mes: '2026-10', conta: '999', servico: 'S3', valor: 5 }], grupos, () => 'f').get('2026-10')!;
    expect(x).toEqual({ outros: 5 });
  });

  it('projeção linear usa só os dias já fechados e espera ter base', () => {
    expect(projetar(88.38, 19, 30)).toBeCloseTo(147.3, 1);
    expect(projetar(10, 2, 30)).toBeUndefined();
  });
});

describe('alertas', () => {
  const agora = Date.parse('2026-11-18T12:00:00Z');
  const status = (cor: 'verde' | 'amarelo' | 'vermelho'): InfraStatusFile => ({
    verificadoEm: '2026-11-18T11:58:00Z',
    produtos: [{ id: 'x', nome: 'Produto X', cor, aws: 'ok', app: 'ok', tipo: 'health', detalhe: 'detalhe', falhasSeguidas: 0, verificadoEm: '2026-11-18T11:58:00Z' }],
  });

  it('vermelho vira crítico, amarelo vira aviso, verde não alerta', () => {
    expect(gerarAlertas(status('vermelho'), null, null, agora)[0]?.nivel).toBe('critico');
    expect(gerarAlertas(status('amarelo'), null, null, agora)[0]?.nivel).toBe('aviso');
    expect(gerarAlertas(status('verde'), null, null, agora)).toEqual([]);
  });

  it('coletor parado há mais de 20 min avisa', () => {
    expect(gerarAlertas(status('verde'), null, null, agora + 30 * 60_000).some((a) => /coletor/.test(a.texto))).toBe(true);
  });

  it('projeção acima do limite e com salto sobre o mês passado avisa', () => {
    const custo: InfraCustoFile = {
      atualizadoEm: '2026-11-18T08:00:00Z',
      grupos: [],
      meses: [{ mes: '2026-10', parcial: false, total: 100, porGrupo: {} }],
      projecao: { mes: '2026-11', total: 150, porGrupo: {} },
    };
    const a = gerarAlertas(null, custo, { contas: [], produtos: [], limites: { mensalUSD: 120 } }, agora);
    expect(a.some((x) => /limite/.test(x.texto))).toBe(true);
    expect(a.some((x) => /50% acima/.test(x.texto))).toBe(true);
  });

  it('com pagador, limite e salto olham só os grupos dele', () => {
    const custo: InfraCustoFile = {
      atualizadoEm: '2026-11-18T08:00:00Z',
      grupos: [
        { id: 'nosso', nome: 'Nosso', pagador: 'Casa' },
        { id: 'cliente', nome: 'Cliente', pagador: 'Cliente' },
      ],
      meses: [{ mes: '2026-10', parcial: false, total: 200, porGrupo: { nosso: 100, cliente: 100 } }],
      projecao: { mes: '2026-11', total: 260, porGrupo: { nosso: 105, cliente: 155 } },
    };
    expect(totalDoPagador(custo.projecao!.porGrupo, custo.grupos, 'Casa')).toBe(105);
    // O cliente subiu 55%, mas quem paga a casa só subiu 5%: nenhum alerta de custo.
    expect(gerarAlertas(null, custo, { contas: [], produtos: [], limites: { mensalUSD: 120, pagador: 'Casa' } }, agora)).toEqual([]);
  });
});
