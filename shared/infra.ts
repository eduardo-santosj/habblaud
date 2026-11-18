// Sala de Infra (fork Vela): o que o coletor do host (scripts/infra-collect.ts) grava e o painel mostra.
// Regras puras e testadas: cor do semáforo, leitura do health, rateio do custo da AWS por produto, projeção do mês
// e alertas. Nada aqui fala com a rede nem lê arquivo.

export type InfraCor = 'verde' | 'amarelo' | 'vermelho' | 'cinza';
/** A máquina na AWS: rodando e com as duas checagens ok, parada, rodando com checagem falhando, ou sem resposta. */
export type AwsEstado = 'ok' | 'parada' | 'problema' | 'desconhecido';
/** O sistema pela URL: ok, de pé mas com dependência fora (banco/redis), sem resposta, ou não verificado. */
export type AppEstado = 'ok' | 'degradado' | 'falha' | 'desconhecido';
/** "health" lê o JSON de saúde (status/db); "site" só confere se a página responde. */
export type InfraTipoUrl = 'health' | 'site';

// ------------------------------------------------------------------ configuração (arquivo local, fora do repo)

export interface InfraContaConfig {
  /** Perfil do AWS CLI (~/.aws), ex.: "producao". */
  perfil: string;
  regiao: string;
  nome: string;
  /** Contas da mesma fatura dividem o imposto entre si (ex.: as contas de uma organização). */
  familia?: string;
  /** true: esta conta enxerga o custo da família inteira (conta gestora da organização). */
  custoDaFamilia?: boolean;
  /** Quem paga a fatura desta conta (ex.: "Vela" ou o nome do cliente). O painel soma por pagador. */
  pagador?: string;
}

export interface InfraProdutoConfig {
  id: string;
  nome: string;
  perfil: string;
  /** Tag Name da instância EC2. */
  maquina: string;
  /** Identificador de um RDS, quando o banco não mora na máquina. */
  banco?: string;
  url?: string;
  tipo?: InfraTipoUrl;
  /** Grupo de custo (produtos na mesma máquina dividem a mesma linha). Padrão: o próprio id. */
  grupo?: string;
}

export interface InfraGrupoConfig {
  id: string;
  nome: string;
  /** Preenchido pelo coletor a partir da conta do grupo. */
  pagador?: string;
}

export interface InfraConfig {
  contas: InfraContaConfig[];
  produtos: InfraProdutoConfig[];
  grupos?: InfraGrupoConfig[];
  /** Limite e salto valem para o total de um pagador (ex.: "Vela"); sem pagador, para a soma de tudo. */
  limites?: { mensalUSD?: number; saltoPercentual?: number; pagador?: string };
}

/** Soma de um mês, só dos grupos de um pagador (sem pagador: tudo). */
export function totalDoPagador(porGrupo: Record<string, number>, grupos: readonly InfraGrupoConfig[], pagador?: string): number {
  const ids = pagador ? new Set(grupos.filter((g) => g.pagador === pagador).map((g) => g.id)) : null;
  const soma = Object.entries(porGrupo).reduce((s, [g, v]) => (ids && !ids.has(g) ? s : s + v), 0);
  return Math.round(soma * 100) / 100;
}

// ------------------------------------------------------------------ o que o coletor grava

export interface InfraProdutoStatus {
  id: string;
  nome: string;
  cor: InfraCor;
  aws: AwsEstado;
  app: AppEstado;
  tipo: InfraTipoUrl | 'nenhum';
  /** Uma linha para a tela, ex.: "máquina ok · sistema ok (320 ms)". */
  detalhe: string;
  latenciaMs?: number;
  /** Falhas seguidas do sistema (o amarelo só acende a partir de 2, para não alarmar por um soluço de rede). */
  falhasSeguidas: number;
  verificadoEm: string;
}

export interface InfraStatusFile {
  verificadoEm: string;
  produtos: InfraProdutoStatus[];
  /** Problemas do próprio coletor (perfil sem permissão, AWS CLI fora do PATH...). */
  erros?: string[];
}

export interface InfraMesCusto {
  /** "AAAA-MM". */
  mes: string;
  parcial: boolean;
  total: number;
  porGrupo: Record<string, number>;
}

export interface InfraCustoFile {
  atualizadoEm: string;
  grupos: InfraGrupoConfig[];
  meses: InfraMesCusto[];
  /** Mês corrente projetado pelo ritmo dos dias já fechados. */
  projecao?: { mes: string; total: number; porGrupo: Record<string, number> };
  erros?: string[];
}

export interface InfraAlerta {
  nivel: 'critico' | 'aviso' | 'info';
  texto: string;
}

export interface InfraSnapshot {
  configurado: boolean;
  status: InfraStatusFile | null;
  custo: InfraCustoFile | null;
  alertas: InfraAlerta[];
}

// ------------------------------------------------------------------ semáforo

/** Quantas falhas seguidas do sistema até acender o amarelo. */
export const FALHAS_PARA_ALERTAR = 2;

/**
 * Cor do produto:
 * - vermelho: a máquina está parada ou com checagem da AWS falhando (aí não importa o sistema);
 * - amarelo: a máquina está ok mas o sistema está degradado, ou falhou FALHAS_PARA_ALERTAR vezes seguidas;
 * - verde: máquina e sistema ok (ou sistema ok sem resposta da AWS);
 * - cinza: não deu para saber nada.
 * Uma falha isolada do sistema mantém a cor anterior (a próxima rodada confirma ou desmente).
 */
export function decidirCor(aws: AwsEstado, app: AppEstado, falhasSeguidas: number, anterior?: InfraCor): InfraCor {
  if (aws === 'parada' || aws === 'problema') return 'vermelho';
  if (app === 'degradado') return 'amarelo';
  if (app === 'falha') {
    if (falhasSeguidas >= FALHAS_PARA_ALERTAR) return aws === 'desconhecido' ? 'vermelho' : 'amarelo';
    return anterior && anterior !== 'cinza' ? anterior : aws === 'ok' ? 'verde' : 'cinza';
  }
  if (app === 'ok') return 'verde';
  return aws === 'ok' ? 'verde' : 'cinza';
}

/**
 * Leitura de uma resposta HTTP. "site": qualquer 2xx/3xx é ok. "health": 2xx com JSON sem sinal de problema é ok;
 * 503 ou JSON dizendo degraded/down (ou um campo db/back/redis "down") é degradado; o resto é falha.
 */
export function lerResposta(tipo: InfraTipoUrl, status: number, corpo: string): AppEstado {
  if (tipo === 'site') return status >= 200 && status < 400 ? 'ok' : 'falha';
  let json: unknown;
  try {
    json = JSON.parse(corpo);
  } catch {
    json = undefined;
  }
  const temProblema = json !== null && typeof json === 'object' && jsonComProblema(json as Record<string, unknown>);
  if (status === 503 && json !== undefined) return 'degradado';
  if (status >= 200 && status < 300) {
    if (json === undefined) return 'falha'; // um 200 em HTML numa rota de health é página de erro do front
    return temProblema ? 'degradado' : 'ok';
  }
  return 'falha';
}

function jsonComProblema(j: Record<string, unknown>): boolean {
  const ruim = (v: unknown) => typeof v === 'string' && /^(down|degraded|error|fail(ed|ing)?|unhealthy)$/i.test(v);
  if (ruim(j.status)) return true;
  for (const k of ['db', 'database', 'back', 'redis', 'banco']) if (ruim(j[k])) return true;
  const checks = j.checks;
  if (checks && typeof checks === 'object') {
    for (const c of Object.values(checks as Record<string, unknown>)) {
      if (c && typeof c === 'object' && (c as { ok?: unknown }).ok === false) return true;
      if (ruim(c)) return true;
    }
  }
  return false;
}

/** Estado da máquina a partir do que a AWS devolve (State.Name + as duas checagens de status). */
export function lerMaquina(estado: string | undefined, sistema?: string, instancia?: string): AwsEstado {
  if (!estado) return 'desconhecido';
  if (estado !== 'running') return estado === 'pending' ? 'ok' : 'parada';
  const ruim = (s?: string) => s === 'impaired';
  return ruim(sistema) || ruim(instancia) ? 'problema' : 'ok';
}

// ------------------------------------------------------------------ custo

/** Preço por hora (on-demand, us-east-1) para ratear o custo de uma conta entre as máquinas dela. */
const PESO_POR_TIPO: Record<string, number> = {
  't3.micro': 0.0104,
  't3.small': 0.0208,
  't3.medium': 0.0416,
  't3.large': 0.0832,
  't4g.micro': 0.0084,
  't4g.small': 0.0168,
  't4g.medium': 0.0336,
  't4g.large': 0.0672,
};

export function pesoDoTipo(tipo: string | undefined): number {
  return (tipo && PESO_POR_TIPO[tipo]) || 0.0208;
}

/** Uma linha do Cost Explorer: mês, conta (id), serviço e valor em US$. */
export interface LinhaCusto {
  mes: string;
  conta: string;
  servico: string;
  valor: number;
}

/** Onde cada grupo de custo mora: conta (id) e peso relativo dentro dela. */
export interface GrupoNaConta {
  grupo: string;
  conta: string;
  peso: number;
}

/** O serviço que é a hora de máquina (divide pelo tamanho da instância; o resto, como IP e disco, divide igual). */
const SERVICO_MAQUINA = /elastic compute cloud - compute/i;

/**
 * Rateia o custo por grupo, mês a mês:
 * - hora de máquina, de cada conta, divide entre os grupos daquela conta pelo peso (tipo da máquina);
 * - os outros serviços da conta (IP público, disco, S3, banco...) dividem em partes iguais entre os grupos dela;
 * - o imposto ("Tax") de uma família (fatura) divide entre todos os grupos da família, proporcional ao que já
 *   receberam (ele é cobrado numa conta só, mas incide sobre a fatura inteira).
 * Conta sem nenhum grupo cadastrado cai em "outros".
 */
export function ratearCusto(linhas: readonly LinhaCusto[], grupos: readonly GrupoNaConta[], familiaDaConta: (conta: string) => string): Map<string, Record<string, number>> {
  const porMes = new Map<string, Record<string, number>>();
  const meses = [...new Set(linhas.map((l) => l.mes))].sort();
  for (const mes of meses) {
    const doMes = linhas.filter((l) => l.mes === mes);
    const out: Record<string, number> = {};
    const add = (g: string, v: number) => (out[g] = (out[g] ?? 0) + v);
    const impostoPorFamilia = new Map<string, number>();
    const contasComCusto = new Set<string>();
    for (const l of doMes) {
      if (/^tax$/i.test(l.servico)) {
        const f = familiaDaConta(l.conta);
        impostoPorFamilia.set(f, (impostoPorFamilia.get(f) ?? 0) + l.valor);
        continue;
      }
      contasComCusto.add(l.conta);
      const daConta = grupos.filter((g) => g.conta === l.conta);
      const peso = (g: GrupoNaConta) => (SERVICO_MAQUINA.test(l.servico) ? g.peso : 1);
      const soma = daConta.reduce((s, g) => s + peso(g), 0);
      if (!daConta.length || soma <= 0) add('outros', l.valor);
      else for (const g of daConta) add(g.grupo, (l.valor * peso(g)) / soma);
    }
    for (const [familia, imposto] of impostoPorFamilia) {
      const contas = new Set([...contasComCusto].filter((c) => familiaDaConta(c) === familia));
      const daFamilia = [...new Set(grupos.filter((g) => contas.has(g.conta)).map((g) => g.grupo))];
      const base = daFamilia.reduce((s, g) => s + (out[g] ?? 0), 0);
      if (!daFamilia.length || base <= 0) add('outros', imposto);
      else for (const g of daFamilia) add(g, (imposto * (out[g] ?? 0)) / base);
    }
    for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;
    porMes.set(mes, out);
  }
  return porMes;
}

/**
 * Projeção linear do mês corrente. O Cost Explorer fecha cada dia com até 24 h de atraso, então conta só os dias
 * já fechados (dia de hoje - 1). Antes do dia 3 não projeta (pouca base).
 */
export function projetar(parcial: number, diaDoMes: number, diasNoMes: number): number | undefined {
  const fechados = diaDoMes - 1;
  if (fechados < 2) return undefined;
  return Math.round(((parcial / fechados) * diasNoMes) * 100) / 100;
}

// ------------------------------------------------------------------ alertas

export function gerarAlertas(status: InfraStatusFile | null, custo: InfraCustoFile | null, config: InfraConfig | null, agora = Date.now()): InfraAlerta[] {
  const out: InfraAlerta[] = [];
  for (const p of status?.produtos ?? []) {
    if (p.cor === 'vermelho') out.push({ nivel: 'critico', texto: `${p.nome}: ${p.detalhe}` });
    else if (p.cor === 'amarelo') out.push({ nivel: 'aviso', texto: `${p.nome}: ${p.detalhe}` });
  }
  if (status && agora - Date.parse(status.verificadoEm) > 20 * 60_000) {
    out.push({ nivel: 'aviso', texto: `O coletor não roda desde ${hora(status.verificadoEm)}: o semáforo pode estar desatualizado.` });
  }
  for (const e of status?.erros ?? []) out.push({ nivel: 'aviso', texto: e });
  for (const e of custo?.erros ?? []) out.push({ nivel: 'aviso', texto: e });

  const limite = config?.limites?.mensalUSD;
  const salto = config?.limites?.saltoPercentual ?? 20;
  const pagador = config?.limites?.pagador;
  const grupos = custo?.grupos ?? [];
  const quem = pagador ? ` (pago pela ${pagador})` : '';
  const proj = custo?.projecao;
  if (proj) {
    const projTotal = pagador ? totalDoPagador(proj.porGrupo, grupos, pagador) : proj.total;
    if (limite && projTotal > limite) {
      out.push({ nivel: 'aviso', texto: `Projeção do mês${quem} US$ ${projTotal.toFixed(2)} passa do limite de US$ ${limite.toFixed(2)}.` });
    }
    const fechados = (custo?.meses ?? []).filter((m) => !m.parcial);
    const anterior = fechados[fechados.length - 1];
    const antTotal = !anterior ? 0 : pagador ? totalDoPagador(anterior.porGrupo, grupos, pagador) : anterior.total;
    if (antTotal > 0 && projTotal > antTotal * (1 + salto / 100)) {
      const pct = Math.round((projTotal / antTotal - 1) * 100);
      out.push({ nivel: 'aviso', texto: `Projeção do mês${quem} ${pct}% acima do mês passado (US$ ${projTotal.toFixed(2)} contra US$ ${antTotal.toFixed(2)}).` });
    }
  }
  if (custo && agora - Date.parse(custo.atualizadoEm) > 5 * 24 * 3_600_000) {
    out.push({ nivel: 'info', texto: `Custo não é atualizado desde ${hora(custo.atualizadoEm)}.` });
  }
  return out;
}

function hora(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
