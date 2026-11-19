// Sala de Marketing (fork Vela): tipos e regras puras, usados pelo coletor do host (scripts/marketing-collect.ts),
// pelo servidor (server/marketing.ts) e pela janela (client/src/ui/marketing.ts).
//
// Fluxo: o coletor lê as métricas das contas do Instagram (só leitura, token no cofre do host) e grava
// metricas.json; a pauta da semana mora em pauta/<segunda>.json, cada item nasce "proposta" e só o dono muda
// para aprovado, ajustar ou descartado. "publicado" só quem marca é o publicador, nunca a janela.
//
// Aprovação em duas etapas: (1) o roteiro; (2) a arte. Roteiro aprovado entra na fila do produtor (fora deste
// repositório), que grava os arquivos em midia/<semana>/<id>/ e marca a arte "pronta"; o dono aprova a arte ou
// pede ajuste (o produtor refaz). Só item com arte aprovada pode ser publicado.

export type MktFormato = 'reels' | 'carrossel' | 'post' | 'story';
export type MktStatus = 'proposta' | 'aprovado' | 'ajustar' | 'descartado' | 'publicado';

/** O que a janela pode pedir. "publicado" fica de fora de propósito. */
export const DECISOES = ['proposta', 'aprovado', 'ajustar', 'descartado'] as const;
export type MktDecisao = (typeof DECISOES)[number];

/** Estado da arte de um item: o produtor marca produzindo, pronta e falhou; o dono marca aprovada e ajustar. */
export type MktArteStatus = 'produzindo' | 'pronta' | 'aprovada' | 'ajustar' | 'falhou';
/** O que a janela pode pedir na etapa da arte ("pronta" = voltar a aprovação). */
export const DECISOES_ARTE = ['pronta', 'aprovada', 'ajustar'] as const;
export type MktDecisaoArte = (typeof DECISOES_ARTE)[number];

export interface MktArte {
  status: MktArteStatus;
  /** Arquivos em midia/<semana>/<id>/, na ordem de exibição (slides do carrossel, vídeo). Só o nome. */
  arquivos: string[];
  /** Ajuste pedido pelo dono na arte. */
  nota?: string;
  /** Motivo da falha do produtor. */
  erro?: string;
  /** Sobe a cada nova produção (o produtor só grava se a versão ainda for a dele). */
  versao: number;
  atualizadoEm?: string;
}

/** Nome de arquivo de mídia aceito (sem caminho) e o tipo que o servidor devolve. */
export const MIDIA_TIPOS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
const MIDIA_NOME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Tipo da mídia pelo nome, ou null se o nome não for aceito (barra, "..", extensão fora da lista). */
export function tipoDaMidia(nome: string): string | null {
  if (!MIDIA_NOME_RE.test(nome) || nome.includes('..')) return null;
  const ext = nome.slice(nome.lastIndexOf('.') + 1).toLowerCase();
  return MIDIA_TIPOS[ext] ?? null;
}

export const ehVideo = (nome: string) => /\.(mp4|webm)$/i.test(nome);

export interface MktConfigConta {
  /** Id curto e estável (ex.: "loja"). */
  id: string;
  /** Nome que aparece na janela. */
  nome: string;
  /** Id da conta profissional do Instagram na Graph API (não é segredo). */
  igUserId: string;
}

export interface MktConfig {
  contas: MktConfigConta[];
}

export interface MktPost {
  id: string;
  tipo: string;
  /** REELS, FEED ou STORY (media_product_type). */
  produto?: string;
  data: string;
  link?: string;
  legenda: string;
  curtidas: number;
  comentarios: number;
  alcance?: number;
  salvos?: number;
  compartilhamentos?: number;
  views?: number;
  interacoes?: number;
}

export interface MktPontoSeguidores {
  dia: string;
  seguidores: number;
}

export interface MktContaMetricas {
  id: string;
  nome: string;
  usuario?: string;
  seguidores?: number;
  totalPosts?: number;
  historico: MktPontoSeguidores[];
  posts: MktPost[];
  erro?: string;
}

export interface MktMetricasFile {
  atualizadoEm: string;
  contas: MktContaMetricas[];
}

export interface MktPautaItem {
  id: string;
  /** Id da conta (MktConfigConta.id). */
  conta: string;
  /** Dia sugerido, AAAA-MM-DD. */
  dia: string;
  hora?: string;
  formato: MktFormato;
  tema: string;
  /** Roteiro ou estrutura dos slides/cenas. */
  roteiro?: string;
  legenda: string;
  /** Por que esse post agora (o raciocínio, para o dono decidir rápido). */
  porque?: string;
  status: MktStatus;
  /** Comentário do dono ao pedir ajuste. */
  nota?: string;
  decididoEm?: string;
  /** Segunda etapa: a arte (existe depois que o roteiro foi aprovado e o produtor pegou o item). */
  arte?: MktArte;
  /** Quando foi postado (à mão pelo dono ou pelo publicador). */
  publicadoEm?: string;
}

export interface MktPautaFile {
  /** Segunda-feira da semana, AAAA-MM-DD. */
  semana: string;
  geradaEm: string;
  itens: MktPautaItem[];
}

export interface MktResumoConta {
  /** Ganho de seguidores nos últimos N dias (undefined sem histórico suficiente). */
  ganho7d?: number;
  alcanceMedio?: number;
  engajamentoMedio?: number;
  melhorPost?: MktPost;
}

export interface MktAlerta {
  nivel: 'aviso' | 'info';
  texto: string;
}

export interface MktSnapshot {
  configurado: boolean;
  metricas: MktMetricasFile | null;
  resumo: Record<string, MktResumoConta>;
  pautas: MktPautaFile[];
  pendentes: number;
  alertas: MktAlerta[];
}

const DIA_MS = 86_400_000;
export const HISTORICO_DIAS = 400;
export const COLETOR_ATRASADO_MS = 26 * 3_600_000;

/** Dia (AAAA-MM-DD) no fuso de São Paulo. */
export function diaSP(t: number | Date = Date.now()): string {
  const d = typeof t === 'number' ? new Date(t) : t;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Segunda-feira da semana de um dia AAAA-MM-DD. */
export function segundaDe(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 = domingo
  const volta = dow === 0 ? 6 : dow - 1;
  return new Date(d.getTime() - volta * DIA_MS).toISOString().slice(0, 10);
}

export function somarDias(dia: string, n: number): string {
  return new Date(new Date(`${dia}T12:00:00Z`).getTime() + n * DIA_MS).toISOString().slice(0, 10);
}

/** Grava o número de seguidores do dia (um ponto por dia, o último vence) e corta o histórico antigo. */
export function registrarSeguidores(historico: readonly MktPontoSeguidores[], dia: string, seguidores: number, max = HISTORICO_DIAS): MktPontoSeguidores[] {
  const mapa = new Map(historico.map((p) => [p.dia, p.seguidores]));
  mapa.set(dia, seguidores);
  return [...mapa.entries()]
    .map(([d, s]) => ({ dia: d, seguidores: s }))
    .sort((a, b) => a.dia.localeCompare(b.dia))
    .slice(-max);
}

/** Ganho de seguidores entre o ponto mais recente e o ponto de N dias antes (ou o mais antigo depois dele). */
export function ganhoEm(historico: readonly MktPontoSeguidores[], dias = 7): number | undefined {
  if (historico.length < 2) return undefined;
  const ultimo = historico[historico.length - 1]!;
  const corte = somarDias(ultimo.dia, -dias);
  const base = historico.find((p) => p.dia >= corte && p.dia < ultimo.dia);
  return base ? ultimo.seguidores - base.seguidores : undefined;
}

/** Interações do post (o total da Meta quando existe; senão a soma do que temos). */
export function interacoesDo(p: MktPost): number {
  return p.interacoes ?? p.curtidas + p.comentarios + (p.salvos ?? 0) + (p.compartilhamentos ?? 0);
}

/** Engajamento sobre o alcance (0 a 1). Sem alcance, não dá pra calcular. */
export function engajamento(p: MktPost): number | undefined {
  return p.alcance && p.alcance > 0 ? interacoesDo(p) / p.alcance : undefined;
}

const media = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined);

/** Resumo de uma conta: ganho em 7 dias e a média dos últimos N posts. */
export function resumirConta(c: MktContaMetricas, ultimos = 10): MktResumoConta {
  const recentes = [...c.posts].sort((a, b) => b.data.localeCompare(a.data)).slice(0, ultimos);
  const alcances = recentes.map((p) => p.alcance).filter((v): v is number => typeof v === 'number');
  const engs = recentes.map(engajamento).filter((v): v is number => typeof v === 'number');
  const melhorPost = recentes.reduce<MktPost | undefined>((m, p) => (!m || interacoesDo(p) > interacoesDo(m) ? p : m), undefined);
  return { ganho7d: ganhoEm(c.historico), alcanceMedio: media(alcances), engajamentoMedio: media(engs), melhorPost };
}

/** Aplica a decisão do dono num item da pauta. Item publicado não muda mais. Lança Error com o motivo. */
export function decidir(pauta: MktPautaFile, id: string, status: string, nota?: string, agora = new Date()): MktPautaFile {
  if (!(DECISOES as readonly string[]).includes(status)) throw new Error(`status inválido: ${status}`);
  const item = pauta.itens.find((i) => i.id === id);
  if (!item) throw new Error('item não encontrado na pauta');
  if (item.status === 'publicado') throw new Error('item já publicado');
  const textoNota = typeof nota === 'string' ? nota.trim().slice(0, 1000) : '';
  if (status === 'ajustar' && !textoNota) throw new Error('diga o que ajustar');
  const novo: MktPautaItem = { ...item, status: status as MktDecisao, decididoEm: agora.toISOString() };
  if (status === 'ajustar') novo.nota = textoNota;
  else if (textoNota) novo.nota = textoNota;
  else delete novo.nota;
  // Roteiro saiu de aprovado: a arte feita para ele não vale mais (os arquivos ficam no disco).
  if (status !== 'aprovado') delete novo.arte;
  return { ...pauta, itens: pauta.itens.map((i) => (i.id === id ? novo : i)) };
}

/** Decisão do dono na arte. Só com o roteiro aprovado e a arte já feita. Lança Error com o motivo. */
export function decidirArte(pauta: MktPautaFile, id: string, status: string, nota?: string, agora = new Date()): MktPautaFile {
  if (!(DECISOES_ARTE as readonly string[]).includes(status)) throw new Error(`status inválido: ${status}`);
  const item = pauta.itens.find((i) => i.id === id);
  if (!item) throw new Error('item não encontrado na pauta');
  if (item.status === 'publicado') throw new Error('item já publicado');
  if (item.status !== 'aprovado' || !item.arte) throw new Error('a arte ainda não existe (aprove o roteiro primeiro)');
  const atual = item.arte.status;
  const textoNota = typeof nota === 'string' ? nota.trim().slice(0, 1000) : '';
  if (status === 'ajustar') {
    // Arte que falhou pode ser pedida de novo sem nota; arte pronta ou aprovada precisa dizer o que mudar.
    if (atual === 'produzindo' || atual === 'ajustar') throw new Error('a arte já está sendo refeita');
    if (!textoNota && atual !== 'falhou') throw new Error('diga o que ajustar na arte');
  } else if (atual !== 'pronta' && atual !== 'aprovada') {
    throw new Error('a arte ainda não está pronta');
  }
  const arte: MktArte = { ...item.arte, status: status as MktDecisaoArte, atualizadoEm: agora.toISOString() };
  if (status === 'ajustar') {
    if (textoNota) arte.nota = textoNota;
    delete arte.erro;
  }
  const novo: MktPautaItem = { ...item, arte };
  return { ...pauta, itens: pauta.itens.map((i) => (i.id === id ? novo : i)) };
}

/**
 * Momento do post (ms) a partir de dia + hora ("18h", "18:30" ou "18h30"), no fuso de São Paulo (UTC-3, sem
 * horário de verão desde 2019). Sem hora válida, null.
 */
export function momentoDoPost(i: Pick<MktPautaItem, 'dia' | 'hora'>): number | null {
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?h?$/i.exec((i.hora ?? '').trim());
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(i.dia)) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2] ?? 0);
  if (hh > 23 || mm > 59) return null;
  return Date.parse(`${i.dia}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-03:00`);
}

/** Pronto para postar: roteiro e arte aprovados, ainda não publicado. */
export const prontoParaPostar = (i: MktPautaItem) => i.status === 'aprovado' && i.arte?.status === 'aprovada';

/**
 * O dono avisa que postou à mão (enquanto não há publicador automático). Só com roteiro e arte aprovados;
 * depois disso o item não muda mais. Lança Error com o motivo.
 */
export function marcarPostado(pauta: MktPautaFile, id: string, agora = new Date()): MktPautaFile {
  const item = pauta.itens.find((i) => i.id === id);
  if (!item) throw new Error('item não encontrado na pauta');
  if (item.status === 'publicado') throw new Error('item já publicado');
  if (!prontoParaPostar(item)) throw new Error('só dá para marcar como postado com o roteiro e a arte aprovados');
  const novo: MktPautaItem = { ...item, status: 'publicado', publicadoEm: agora.toISOString() };
  return { ...pauta, itens: pauta.itens.map((i) => (i.id === id ? novo : i)) };
}

/** O produtor deve fazer (ou refazer) a arte deste item? */
export function precisaProduzir(i: MktPautaItem): boolean {
  return i.status === 'aprovado' && (!i.arte || i.arte.status === 'ajustar');
}

/** Itens que esperam o dono: roteiros propostos e artes prontas. */
export function contarPendentes(pautas: readonly MktPautaFile[]): number {
  return pautas.reduce((s, p) => s + p.itens.filter((i) => i.status === 'proposta' || (i.status === 'aprovado' && i.arte?.status === 'pronta')).length, 0);
}

export function gerarAlertasMkt(metricas: MktMetricasFile | null, pautas: readonly MktPautaFile[], agora = Date.now()): MktAlerta[] {
  const alertas: MktAlerta[] = [];
  if (metricas) {
    if (agora - Date.parse(metricas.atualizadoEm) > COLETOR_ATRASADO_MS) alertas.push({ nivel: 'aviso', texto: 'O coletor do Instagram não roda há mais de um dia: os números podem estar velhos.' });
    for (const c of metricas.contas) if (c.erro) alertas.push({ nivel: 'aviso', texto: `${c.nome}: ${c.erro}` });
  }
  const hoje = diaSP(agora);
  const proxima = somarDias(segundaDe(hoje), 7);
  const itens = pautas.flatMap((p) => p.itens);
  const roteiros = itens.filter((i) => i.status === 'proposta').length;
  const artes = itens.filter((i) => i.status === 'aprovado' && i.arte?.status === 'pronta').length;
  const falhas = itens.filter((i) => i.status === 'aprovado' && i.arte?.status === 'falhou').length;
  if (roteiros) alertas.push({ nivel: 'info', texto: `${roteiros} roteiro(s) esperando sua aprovação.` });
  if (artes) alertas.push({ nivel: 'info', texto: `${artes} arte(s) pronta(s) esperando sua aprovação.` });
  if (falhas) alertas.push({ nivel: 'aviso', texto: `${falhas} arte(s) não saíram: veja o motivo no post e peça de novo.` });
  // Lembretes de postagem (enquanto a publicação é à mão).
  for (const i of itens) {
    const quando = momentoDoPost(i);
    if (quando === null || i.status !== 'aprovado') continue;
    const hora = i.hora ?? '';
    if (prontoParaPostar(i)) {
      if (agora >= quando) alertas.push({ nivel: 'aviso', texto: `Passou da hora de postar "${i.tema}" (${hora}). Postou? Marque "Já postei".` });
      else if (diaSP(quando) === hoje) alertas.push({ nivel: 'info', texto: `Hoje às ${hora}: postar "${i.tema}".` });
    } else if (quando - agora < DIA_MS && quando > agora) {
      alertas.push({ nivel: 'aviso', texto: `"${i.tema}" sai em menos de 24 h e a arte ainda não foi aprovada.` });
    }
  }
  // Da sexta em diante, a semana que vem já devia estar decidida.
  const dow = new Date(`${hoje}T12:00:00Z`).getUTCDay();
  if ((dow === 5 || dow === 6 || dow === 0) && !pautas.some((p) => p.semana === proxima && p.itens.length))
    alertas.push({ nivel: 'aviso', texto: 'A pauta da semana que vem ainda não foi montada.' });
  return alertas;
}
