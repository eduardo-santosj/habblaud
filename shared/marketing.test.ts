import { describe, expect, it } from 'vitest';
import { contarPendentes, decidir, decidirArte, diaSP, engajamento, ganhoEm, gerarAlertasMkt, precisaProduzir, registrarSeguidores, resumirConta, segundaDe, tipoDaMidia, type MktPautaFile, type MktPautaItem, type MktPost } from './marketing';

const post = (p: Partial<MktPost>): MktPost => ({ id: 'p', tipo: 'IMAGE', data: '2026-11-10T12:00:00+0000', legenda: '', curtidas: 0, comentarios: 0, ...p });

describe('datas', () => {
  it('dia no fuso de São Paulo (23h de SP ainda é o mesmo dia)', () => {
    expect(diaSP(Date.parse('2026-11-19T02:30:00Z'))).toBe('2026-11-18');
  });

  it('segunda-feira da semana, inclusive no domingo', () => {
    expect(segundaDe('2026-11-18')).toBe('2026-11-16');
    expect(segundaDe('2026-11-16')).toBe('2026-11-16');
    expect(segundaDe('2026-11-22')).toBe('2026-11-16');
  });
});

describe('seguidores', () => {
  it('um ponto por dia: o último do dia vence, em ordem, cortando o antigo', () => {
    let h = registrarSeguidores([], '2026-11-10', 100);
    h = registrarSeguidores(h, '2026-11-12', 110);
    h = registrarSeguidores(h, '2026-11-12', 112);
    h = registrarSeguidores(h, '2026-11-11', 105, 2);
    expect(h).toEqual([
      { dia: '2026-11-11', seguidores: 105 },
      { dia: '2026-11-12', seguidores: 112 },
    ]);
  });

  it('ganho em 7 dias usa o primeiro ponto dentro da janela; sem histórico, indefinido', () => {
    const h = [
      { dia: '2026-11-01', seguidores: 90 },
      { dia: '2026-11-11', seguidores: 100 },
      { dia: '2026-11-15', seguidores: 104 },
      { dia: '2026-11-18', seguidores: 110 },
    ];
    expect(ganhoEm(h)).toBe(10);
    expect(ganhoEm([{ dia: '2026-11-18', seguidores: 1 }])).toBeUndefined();
  });
});

describe('engajamento', () => {
  it('usa o total de interações da Meta quando existe; sem alcance não calcula', () => {
    expect(engajamento(post({ alcance: 200, interacoes: 20, curtidas: 999 }))).toBeCloseTo(0.1);
    expect(engajamento(post({ alcance: 100, curtidas: 5, comentarios: 2, salvos: 1, compartilhamentos: 2 }))).toBeCloseTo(0.1);
    expect(engajamento(post({ curtidas: 5 }))).toBeUndefined();
  });

  it('resumo da conta: médias dos posts recentes e o post com mais interações', () => {
    const r = resumirConta({
      id: 'a',
      nome: 'A',
      historico: [],
      posts: [post({ id: '1', alcance: 100, curtidas: 10 }), post({ id: '2', alcance: 300, curtidas: 3, data: '2026-11-12T12:00:00+0000' })],
    });
    expect(r.alcanceMedio).toBe(200);
    expect(r.engajamentoMedio).toBeCloseTo((0.1 + 0.01) / 2);
    expect(r.melhorPost?.id).toBe('1');
  });
});

describe('pauta', () => {
  const pauta: MktPautaFile = {
    semana: '2026-11-23',
    geradaEm: '2026-11-18T20:00:00Z',
    itens: [
      { id: 'a', conta: 'loja', dia: '2026-11-24', formato: 'carrossel', tema: 'T', legenda: 'L', status: 'proposta' },
      { id: 'b', conta: 'loja', dia: '2026-11-26', formato: 'reels', tema: 'T', legenda: 'L', status: 'publicado' },
    ],
  };

  it('aprovar muda só o item e registra quando', () => {
    const n = decidir(pauta, 'a', 'aprovado', undefined, new Date('2026-11-20T12:00:00Z'));
    expect(n.itens[0]).toMatchObject({ status: 'aprovado', decididoEm: '2026-11-20T12:00:00.000Z' });
    expect(n.itens[1]).toBe(pauta.itens[1]);
    expect(pauta.itens[0]!.status).toBe('proposta');
  });

  it('pedir ajuste exige dizer o quê', () => {
    expect(() => decidir(pauta, 'a', 'ajustar', '  ')).toThrow(/ajustar/);
    expect(decidir(pauta, 'a', 'ajustar', 'trocar a capa').itens[0]!.nota).toBe('trocar a capa');
  });

  it('a janela nunca marca publicado nem mexe em item publicado', () => {
    expect(() => decidir(pauta, 'a', 'publicado')).toThrow(/inválido/);
    expect(() => decidir(pauta, 'b', 'descartado')).toThrow(/publicado/);
    expect(() => decidir(pauta, 'x', 'aprovado')).toThrow(/não encontrado/);
  });

  it('conta pendentes e avisa na sexta se a semana que vem está vazia', () => {
    expect(contarPendentes([pauta])).toBe(1);
    const sexta = Date.parse('2026-11-20T15:00:00Z');
    expect(gerarAlertasMkt(null, [], sexta).some((a) => /semana que vem/.test(a.texto))).toBe(true);
    expect(gerarAlertasMkt(null, [pauta], sexta).some((a) => /semana que vem/.test(a.texto))).toBe(false);
    expect(gerarAlertasMkt(null, [], Date.parse('2026-11-18T15:00:00Z'))).toEqual([]);
  });

  it('coletor parado há mais de um dia avisa', () => {
    const m = { atualizadoEm: '2026-11-17T00:00:00Z', contas: [] };
    expect(gerarAlertasMkt(m, [], Date.parse('2026-11-18T12:00:00Z')).some((a) => /coletor/.test(a.texto))).toBe(true);
  });
});

describe('arte (segunda etapa)', () => {
  const base: MktPautaItem = { id: 'a', conta: 'loja', dia: '2026-11-24', formato: 'carrossel', tema: 'T', legenda: 'L', status: 'aprovado' };
  const com = (arte?: MktPautaItem['arte'], status: MktPautaItem['status'] = 'aprovado'): MktPautaFile => ({ semana: '2026-11-23', geradaEm: 'x', itens: [{ ...base, status, arte }] });
  const pronta = { status: 'pronta' as const, arquivos: ['01.png', '02.png'], versao: 1 };

  it('roteiro aprovado sem arte (ou com ajuste pedido) entra na fila do produtor', () => {
    expect(precisaProduzir(base)).toBe(true);
    expect(precisaProduzir({ ...base, arte: { ...pronta, status: 'ajustar' } })).toBe(true);
    expect(precisaProduzir({ ...base, arte: pronta })).toBe(false);
    expect(precisaProduzir({ ...base, status: 'proposta' })).toBe(false);
  });

  it('aprovar a arte pronta; pedir ajuste exige nota, menos quando a produção falhou', () => {
    expect(decidirArte(com(pronta), 'a', 'aprovada').itens[0]!.arte!.status).toBe('aprovada');
    expect(() => decidirArte(com(pronta), 'a', 'ajustar', ' ')).toThrow(/ajustar/);
    const aj = decidirArte(com(pronta), 'a', 'ajustar', 'logo maior').itens[0]!.arte!;
    expect(aj).toMatchObject({ status: 'ajustar', nota: 'logo maior', arquivos: ['01.png', '02.png'], versao: 1 });
    const falhou = decidirArte(com({ status: 'falhou', arquivos: [], erro: 'timeout', versao: 2 }), 'a', 'ajustar').itens[0]!.arte!;
    expect(falhou.status).toBe('ajustar');
    expect(falhou.erro).toBeUndefined();
  });

  it('recusa arte inexistente, em produção, roteiro não aprovado e status fora da lista', () => {
    expect(() => decidirArte(com(undefined), 'a', 'aprovada')).toThrow(/ainda não existe/);
    expect(() => decidirArte(com({ ...pronta, status: 'produzindo' }), 'a', 'aprovada')).toThrow(/não está pronta/);
    expect(() => decidirArte(com({ ...pronta, status: 'produzindo' }), 'a', 'ajustar', 'x')).toThrow(/refeita/);
    expect(() => decidirArte(com(pronta, 'proposta'), 'a', 'aprovada')).toThrow(/ainda não existe/);
    expect(() => decidirArte(com(pronta), 'a', 'publicado')).toThrow(/inválido/);
  });

  it('roteiro que sai de aprovado perde a arte; arte pronta conta como pendente', () => {
    expect(decidir(com(pronta), 'a', 'ajustar', 'mudar o tema').itens[0]!.arte).toBeUndefined();
    expect(decidir(com(pronta), 'a', 'aprovado').itens[0]!.arte).toEqual(pronta);
    expect(contarPendentes([com(pronta)])).toBe(1);
    expect(contarPendentes([com({ ...pronta, status: 'aprovada' })])).toBe(0);
  });

  it('nome de mídia: só arquivo simples com extensão de imagem ou vídeo', () => {
    expect(tipoDaMidia('01.png')).toBe('image/png');
    expect(tipoDaMidia('reels.MP4')).toBe('video/mp4');
    for (const ruim of ['../x.png', 'a/b.png', '..png', 'x.svg', 'x.html', '.png', 'x'.repeat(130) + '.png']) expect(tipoDaMidia(ruim)).toBeNull();
  });
});
