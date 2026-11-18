#!/usr/bin/env tsx
// Coletor da sala de Infra (fork Vela). Roda NO HOST, onde estão os perfis do AWS CLI: as chaves nunca entram
// no container. Grava em <HABBLAUD_USAGE_DIR ou ~/.habblaud/usage>/infra/ (montada em /usage no Docker):
//   - status.json: máquina na AWS + health de cada produto (a cada 5 min no modo --daemon);
//   - custo.json:  custo por mês e por grupo, com projeção do mês (segunda e quinta no modo --daemon).
// Lê a configuração de infra/config.json (local, fora do repositório: nomes, perfis e URLs são do dono).
//
// Uso: npm run infra:status · npm run infra:custo · npm run infra:daemon
// Só leitura na AWS (ec2 describe-*, rds describe-db-instances, ce get-cost-and-usage, sts get-caller-identity).
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  decidirCor,
  lerMaquina,
  lerResposta,
  pesoDoTipo,
  projetar,
  ratearCusto,
  type AppEstado,
  type AwsEstado,
  type GrupoNaConta,
  type InfraConfig,
  type InfraContaConfig,
  type InfraCustoFile,
  type InfraProdutoStatus,
  type InfraStatusFile,
  type LinhaCusto,
} from '../shared/infra';

const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
const dir = join(process.env.HABBLAUD_USAGE_DIR?.trim() || join(home, '.habblaud', 'usage'), 'infra');
const ARQ = { config: join(dir, 'config.json'), status: join(dir, 'status.json'), custo: join(dir, 'custo.json') };
const STATUS_MS = 5 * 60_000;
const HEALTH_TIMEOUT_MS = 8_000;
const MESES = 6;

function lerJson<T>(arq: string): T | null {
  try {
    return JSON.parse(readFileSync(arq, 'utf8')) as T;
  } catch {
    return null;
  }
}

function gravar(arq: string, dado: unknown): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${arq}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(dado, null, 2)}\n`);
  renameSync(tmp, arq);
}

/** Roda o AWS CLI e devolve o JSON. Nunca passa segredo: só o nome do perfil. */
function aws<T>(conta: InfraContaConfig, args: string[], regiao = conta.regiao): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile('aws', [...args, '--profile', conta.perfil, '--region', regiao, '--output', 'json'], { timeout: 30_000, windowsHide: true }, (err, out, errOut) => {
      if (err) return reject(new Error((errOut || err.message).trim().split('\n').pop() ?? 'falhou'));
      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(new Error('resposta inesperada do AWS CLI'));
      }
    });
  });
}

// ------------------------------------------------------------------ status

interface Maquina {
  id: string;
  tipo: string;
  estado: string;
}
interface DescribeInstances {
  Reservations: { Instances: { InstanceId: string; InstanceType: string; State: { Name: string }; Tags?: { Key: string; Value: string }[] }[] }[];
}
interface DescribeStatus {
  InstanceStatuses: { InstanceId: string; SystemStatus?: { Status: string }; InstanceStatus?: { Status: string } }[];
}
interface DescribeDb {
  DBInstances: { DBInstanceIdentifier: string; DBInstanceStatus: string }[];
}

async function maquinasDaConta(conta: InfraContaConfig): Promise<Map<string, Maquina & { sistema?: string; instancia?: string }>> {
  const [inst, st] = await Promise.all([
    aws<DescribeInstances>(conta, ['ec2', 'describe-instances']),
    aws<DescribeStatus>(conta, ['ec2', 'describe-instance-status', '--include-all-instances']),
  ]);
  const saude = new Map(st.InstanceStatuses.map((s) => [s.InstanceId, s]));
  const out = new Map<string, Maquina & { sistema?: string; instancia?: string }>();
  for (const r of inst.Reservations) {
    for (const i of r.Instances) {
      const nome = i.Tags?.find((t) => t.Key === 'Name')?.Value;
      if (!nome || i.State.Name === 'terminated') continue;
      const s = saude.get(i.InstanceId);
      out.set(nome, { id: i.InstanceId, tipo: i.InstanceType, estado: i.State.Name, sistema: s?.SystemStatus?.Status, instancia: s?.InstanceStatus?.Status });
    }
  }
  return out;
}

async function checarUrl(url: string, tipo: 'health' | 'site'): Promise<{ app: AppEstado; ms?: number; nota: string }> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), headers: { 'user-agent': 'habblaud-infra/1' } });
    const corpo = tipo === 'health' ? (await r.text()).slice(0, 4_000) : '';
    const ms = Date.now() - t0;
    const app = lerResposta(tipo, r.status, corpo);
    return { app, ms, nota: app === 'ok' ? `${ms} ms` : `HTTP ${r.status}` };
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    const nota = /ENOTFOUND|EAI_AGAIN/.test(code) ? 'nome não resolveu (DNS)' : code === 'TimeoutError' ? `sem resposta em ${HEALTH_TIMEOUT_MS / 1000} s` : code;
    return { app: 'falha', nota };
  }
}

const TEXTO_AWS: Record<AwsEstado, string> = { ok: 'máquina ok', parada: 'máquina PARADA', problema: 'máquina com falha na checagem da AWS', desconhecido: 'AWS sem resposta' };
const TEXTO_APP: Record<AppEstado, string> = { ok: 'sistema ok', degradado: 'sistema de pé, mas com dependência fora', falha: 'sistema não responde', desconhecido: 'sem verificação do sistema' };

export async function coletarStatus(config: InfraConfig): Promise<InfraStatusFile> {
  const agora = new Date().toISOString();
  const anterior = lerJson<InfraStatusFile>(ARQ.status);
  const antes = new Map((anterior?.produtos ?? []).map((p) => [p.id, p]));
  const erros: string[] = [];

  const porConta = new Map<string, Awaited<ReturnType<typeof maquinasDaConta>> | null>();
  const bancos = new Map<string, Map<string, string> | null>();
  await Promise.all(
    config.contas.map(async (c) => {
      try {
        porConta.set(c.perfil, await maquinasDaConta(c));
      } catch (e) {
        porConta.set(c.perfil, null);
        erros.push(`AWS (${c.nome}): ${(e as Error).message}`);
      }
      if (config.produtos.some((p) => p.perfil === c.perfil && p.banco)) {
        try {
          const db = await aws<DescribeDb>(c, ['rds', 'describe-db-instances']);
          bancos.set(c.perfil, new Map(db.DBInstances.map((d) => [d.DBInstanceIdentifier, d.DBInstanceStatus])));
        } catch {
          bancos.set(c.perfil, null);
        }
      }
    }),
  );

  const produtos = await Promise.all(
    config.produtos.map(async (p): Promise<InfraProdutoStatus> => {
      const maquinas = porConta.get(p.perfil);
      const m = maquinas?.get(p.maquina);
      let aws: AwsEstado = maquinas ? (m ? lerMaquina(m.estado, m.sistema, m.instancia) : 'parada') : 'desconhecido';
      const partes: string[] = [];
      if (maquinas && !m) partes.push(`máquina "${p.maquina}" não encontrada`);
      if (p.banco) {
        const st = bancos.get(p.perfil)?.get(p.banco);
        if (st && st !== 'available' && aws === 'ok') aws = 'problema';
        if (st && st !== 'available') partes.push(`banco ${st}`);
      }
      const tipo = p.url ? (p.tipo ?? 'health') : 'nenhum';
      const r = p.url ? await checarUrl(p.url, p.tipo ?? 'health') : { app: 'desconhecido' as AppEstado, nota: '' };
      const prev = antes.get(p.id);
      const falhasSeguidas = r.app === 'falha' ? (prev?.falhasSeguidas ?? 0) + 1 : 0;
      const cor = decidirCor(aws, r.app, falhasSeguidas, prev?.cor);
      const confirmando = r.app === 'falha' && falhasSeguidas === 1 ? ' (1ª falha, confirmando na próxima rodada)' : '';
      const detalhe = [TEXTO_AWS[aws], ...partes, `${TEXTO_APP[r.app]}${r.nota ? ` (${r.nota})` : ''}${tipo === 'site' && r.app === 'ok' ? ', só o site' : ''}${confirmando}`].join(' · ');
      return { id: p.id, nome: p.nome, cor, aws, app: r.app, tipo, detalhe, latenciaMs: r.ms, falhasSeguidas, verificadoEm: agora };
    }),
  );
  return { verificadoEm: agora, produtos, erros: erros.length ? erros : undefined };
}

// ------------------------------------------------------------------ custo

interface CeResultado {
  ResultsByTime: { TimePeriod: { Start: string }; Groups: { Keys: string[]; Metrics: { UnblendedCost: { Amount: string } } }[] }[];
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function coletarCusto(config: InfraConfig, hoje = new Date()): Promise<InfraCustoFile> {
  const inicio = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - (MESES - 1), 1));
  const fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
  const erros: string[] = [];

  // Id de cada conta (o Cost Explorer agrupa por id) e família (quem divide imposto).
  const idPorPerfil = new Map<string, string>();
  await Promise.all(
    config.contas.map(async (c) => {
      try {
        idPorPerfil.set(c.perfil, (await aws<{ Account: string }>(c, ['sts', 'get-caller-identity'])).Account);
      } catch (e) {
        erros.push(`AWS (${c.nome}): ${(e as Error).message}`);
      }
    }),
  );
  const familiaPorId = new Map(config.contas.map((c) => [idPorPerfil.get(c.perfil) ?? c.perfil, c.familia ?? c.perfil]));

  // Uma consulta por família: a conta gestora (custoDaFamilia) enxerga as contas filhas.
  const linhas: LinhaCusto[] = [];
  const familias = new Map<string, InfraContaConfig>();
  for (const c of config.contas) {
    const f = c.familia ?? c.perfil;
    if (!familias.has(f) || c.custoDaFamilia) familias.set(f, c);
  }
  for (const c of familias.values()) {
    try {
      const r = await aws<CeResultado>(
        c,
        ['ce', 'get-cost-and-usage', '--time-period', `Start=${ymd(inicio)},End=${ymd(fim)}`, '--granularity', 'MONTHLY', '--metrics', 'UnblendedCost', '--group-by', 'Type=DIMENSION,Key=LINKED_ACCOUNT', 'Type=DIMENSION,Key=SERVICE'],
        'us-east-1',
      );
      for (const t of r.ResultsByTime) {
        for (const g of t.Groups) {
          const valor = Number(g.Metrics.UnblendedCost.Amount);
          if (Math.abs(valor) >= 0.005) linhas.push({ mes: t.TimePeriod.Start.slice(0, 7), conta: g.Keys[0], servico: g.Keys[1], valor });
        }
      }
    } catch (e) {
      erros.push(`Custo (${c.nome}): ${(e as Error).message}`);
    }
  }

  // Onde cada grupo mora e o peso dele (tamanho da máquina).
  const tipos = new Map<string, string>();
  await Promise.all(
    config.contas.map(async (c) => {
      try {
        for (const [nome, m] of await maquinasDaConta(c)) tipos.set(`${c.perfil}/${nome}`, m.tipo);
      } catch {
        // sem o tipo, o peso padrão serve
      }
    }),
  );
  const grupos: GrupoNaConta[] = [];
  const vistos = new Set<string>();
  for (const p of config.produtos) {
    const grupo = p.grupo ?? p.id;
    if (vistos.has(grupo)) continue;
    vistos.add(grupo);
    grupos.push({ grupo, conta: idPorPerfil.get(p.perfil) ?? p.perfil, peso: pesoDoTipo(tipos.get(`${p.perfil}/${p.maquina}`)) });
  }

  const rateio = ratearCusto(linhas, grupos, (id) => familiaPorId.get(id) ?? id);
  const mesAtual = ymd(hoje).slice(0, 7);
  const meses = [...rateio.entries()].map(([mes, porGrupo]) => ({
    mes,
    parcial: mes === mesAtual,
    porGrupo,
    total: Math.round(Object.values(porGrupo).reduce((s, v) => s + v, 0) * 100) / 100,
  }));

  const atual = meses.find((m) => m.mes === mesAtual);
  const diasNoMes = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 0)).getUTCDate();
  let projecao: InfraCustoFile['projecao'];
  const total = atual ? projetar(atual.total, hoje.getUTCDate(), diasNoMes) : undefined;
  if (atual && total !== undefined) {
    const fator = atual.total > 0 ? total / atual.total : 0;
    const porGrupo = Object.fromEntries(Object.entries(atual.porGrupo).map(([g, v]) => [g, Math.round(v * fator * 100) / 100]));
    projecao = { mes: mesAtual, total, porGrupo };
  }

  const nomes = new Map((config.grupos ?? []).map((g) => [g.id, g.nome]));
  const idsGrupo = [...vistos, ...(meses.some((m) => m.porGrupo.outros) ? ['outros'] : [])];
  const pagadorDoGrupo = (id: string) => {
    const p = config.produtos.find((x) => (x.grupo ?? x.id) === id);
    return config.contas.find((c) => c.perfil === p?.perfil)?.pagador;
  };
  return {
    atualizadoEm: new Date().toISOString(),
    grupos: idsGrupo.map((id) => ({ id, nome: nomes.get(id) ?? config.produtos.find((p) => p.id === id)?.nome ?? (id === 'outros' ? 'Outros' : id), pagador: pagadorDoGrupo(id) })),
    meses,
    projecao,
    erros: erros.length ? erros : undefined,
  };
}

// ------------------------------------------------------------------ execução

function carregarConfig(): InfraConfig {
  const c = lerJson<InfraConfig>(ARQ.config);
  if (!c?.contas?.length || !c.produtos?.length) throw new Error(`configuração não encontrada ou vazia em ${ARQ.config}`);
  return c;
}

/** Custo roda segunda e quinta a partir das 8 h (hora local), uma vez por dia; ou se nunca rodou. */
export function horaDoCusto(ultimo: string | undefined, agora = new Date()): boolean {
  if (!ultimo) return true;
  const dia = agora.getDay();
  if ((dia !== 1 && dia !== 4) || agora.getHours() < 8) return false;
  return new Date(ultimo).toDateString() !== agora.toDateString();
}

async function rodarStatus(): Promise<void> {
  const s = await coletarStatus(carregarConfig());
  gravar(ARQ.status, s);
  const resumo = s.produtos.map((p) => `${p.cor === 'verde' ? 'OK' : p.cor.toUpperCase()} ${p.nome}`).join(' | ');
  console.log(`[infra] status ${new Date().toLocaleTimeString('pt-BR')}: ${resumo}`);
}

async function rodarCusto(): Promise<void> {
  const c = await coletarCusto(carregarConfig());
  gravar(ARQ.custo, c);
  const ultimo = c.meses.filter((m) => !m.parcial).pop();
  console.log(`[infra] custo: último mês fechado ${ultimo?.mes ?? '-'} US$ ${ultimo?.total.toFixed(2) ?? '-'}; projeção ${c.projecao ? `US$ ${c.projecao.total.toFixed(2)}` : '-'}`);
}

async function daemon(): Promise<void> {
  console.log(`[infra] coletor ligado: status a cada ${STATUS_MS / 60_000} min, custo segunda e quinta. Pasta: ${dir}`);
  const ciclo = async () => {
    try {
      await rodarStatus();
    } catch (e) {
      console.error(`[infra] status falhou: ${(e as Error).message}`);
    }
    try {
      if (horaDoCusto(lerJson<InfraCustoFile>(ARQ.custo)?.atualizadoEm)) await rodarCusto();
    } catch (e) {
      console.error(`[infra] custo falhou: ${(e as Error).message}`);
    }
  };
  await ciclo();
  setInterval(() => void ciclo(), STATUS_MS);
}

const arg = process.argv.slice(2);
if (process.argv[1] && /infra-collect/.test(process.argv[1])) {
  const run = arg.includes('--daemon') ? daemon() : arg.includes('--custo') ? rodarCusto() : rodarStatus();
  run.catch((e: Error) => {
    console.error(`[infra] ${e.message}`);
    process.exit(1);
  });
}
