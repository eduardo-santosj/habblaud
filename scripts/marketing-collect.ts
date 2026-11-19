#!/usr/bin/env tsx
// Coletor da sala de Marketing (fork Vela). Roda NO HOST: o token da Meta fica num arquivo local (cofre) e nunca
// entra no container nem no log. Só leitura na Graph API (perfil, posts e métricas dos posts).
// Grava em <HABBLAUD_USAGE_DIR ou ~/.habblaud/usage>/marketing/metricas.json.
// Contas em marketing/config.json; sem config, descobre as contas do Instagram ligadas às páginas do token
// e grava a config (ids não são segredo).
//
// Token: HABBLAUD_META_TOKEN_FILE ou ~/.vela/segredos/meta-token.
// Uso: npm run mkt:coletar · npm run mkt:daemon (coleta a cada 6 h)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { diaSP, registrarSeguidores, type MktConfig, type MktContaMetricas, type MktMetricasFile, type MktPost } from '../shared/marketing';

const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
const dir = join(process.env.HABBLAUD_USAGE_DIR?.trim() || join(home, '.habblaud', 'usage'), 'marketing');
const ARQ = { config: join(dir, 'config.json'), metricas: join(dir, 'metricas.json') };
const TOKEN_ARQ = process.env.HABBLAUD_META_TOKEN_FILE?.trim() || join(home, '.vela', 'segredos', 'meta-token');
const GRAPH = 'https://graph.facebook.com/v24.0';
const TIMEOUT_MS = 10_000;
const POSTS = 15;
const PARALELO = 3;
const INTERVALO_MS = 6 * 3_600_000;
const CHECAGEM_MS = 15 * 60_000;

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

function lerToken(): string {
  let t = '';
  try {
    t = readFileSync(TOKEN_ARQ, 'utf8').trim();
  } catch {
    // tratado abaixo
  }
  if (!t) throw new Error('token da Meta não encontrado no cofre');
  return t;
}

class GraphErro extends Error {}

/** GET na Graph API. A mensagem de erro é a da Meta (nunca contém o token); falha de rede vira texto curto. */
async function graph<T>(token: string, caminho: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${GRAPH}/${caminho}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new GraphErro((e as Error)?.name === 'TimeoutError' ? 'a Meta não respondeu em 10 s' : 'falha de rede ao falar com a Meta');
  }
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (j.error) throw new GraphErro(`Meta ${j.error.code ?? ''}: ${j.error.message ?? 'erro'}`.trim());
  if (!r.ok) throw new GraphErro(`Meta respondeu ${r.status}`);
  return j;
}

async function emLotes<T, R>(itens: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < itens.length; i += n) out.push(...(await Promise.all(itens.slice(i, i + n).map(fn))));
  return out;
}

async function descobrirContas(token: string): Promise<MktConfig> {
  type Pag = { data?: Array<{ name: string; instagram_business_account?: { id: string; username?: string } }> };
  const r = await graph<Pag>(token, 'me/accounts', { fields: 'name,instagram_business_account{id,username}', limit: '50' });
  const contas = (r.data ?? [])
    .filter((p) => p.instagram_business_account)
    .map((p) => ({
      id: (p.instagram_business_account!.username ?? p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      nome: p.name,
      igUserId: p.instagram_business_account!.id,
    }));
  return { contas };
}

type Insight = { data?: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> };

/** Métricas de um post. Nem todo tipo aceita todas as métricas: tenta a lista cheia e, se a Meta recusar, a básica. */
async function insightsDo(token: string, id: string): Promise<Partial<MktPost>> {
  for (const metricas of ['reach,saved,shares,total_interactions,views', 'reach,saved,total_interactions']) {
    try {
      const r = await graph<Insight>(token, `${id}/insights`, { metric: metricas });
      const v = (nome: string) => {
        const m = r.data?.find((x) => x.name === nome);
        return m?.total_value?.value ?? m?.values?.[0]?.value;
      };
      return { alcance: v('reach'), salvos: v('saved'), compartilhamentos: v('shares'), interacoes: v('total_interactions'), views: v('views') };
    } catch {
      // tenta a lista menor
    }
  }
  return {};
}

type Online = { data?: Array<{ values?: Array<{ value?: Record<string, number>; end_time?: string }> }> };

/**
 * Seguidores online por hora (métrica online_followers). A Meta devolve um dia por vez, com as horas no fuso dela;
 * o end_time (meia-noite desse fuso, em UTC) diz o deslocamento. Junta os dias novos aos já medidos (chave =
 * end_time, até 30 dias), cada um com 24 posições no fuso de São Paulo (índice = hora de SP).
 */
export function juntarOnline(r: Online, antes: Record<string, number[]> = {}, max = 30): Record<string, number[]> {
  const dias: Record<string, number[]> = { ...antes };
  for (const v of r.data?.[0]?.values ?? []) {
    if (!v.end_time || !v.value || Object.keys(v.value).length < 24) continue;
    const fimUtc = new Date(v.end_time).getUTCHours();
    const porHora = new Array<number>(24).fill(0);
    for (const [k, n] of Object.entries(v.value)) {
      const h = Number(k);
      // end_time às 08:00 UTC = meia-noite em UTC-8: hora local h vira h + 8 em UTC, h + 8 - 3 em São Paulo.
      if (Number.isInteger(h) && h >= 0 && h <= 23 && typeof n === 'number') porHora[(((h + fimUtc - 3) % 24) + 24) % 24] = n;
    }
    dias[v.end_time] = porHora;
  }
  const chaves = Object.keys(dias).sort().slice(-max);
  return Object.fromEntries(chaves.map((k) => [k, dias[k]!]));
}

async function coletarConta(token: string, c: MktConfig['contas'][number], anterior?: MktContaMetricas): Promise<MktContaMetricas> {
  const base: MktContaMetricas = { id: c.id, nome: c.nome, historico: anterior?.historico ?? [], posts: anterior?.posts ?? [] };
  try {
    const perfil = await graph<{ username?: string; followers_count?: number; media_count?: number }>(token, c.igUserId, { fields: 'username,followers_count,media_count' });
    type Midia = { data?: Array<{ id: string; media_type: string; media_product_type?: string; timestamp: string; permalink?: string; caption?: string; like_count?: number; comments_count?: number }> };
    const midias = await graph<Midia>(token, `${c.igUserId}/media`, {
      fields: 'id,media_type,media_product_type,timestamp,permalink,caption,like_count,comments_count',
      limit: String(POSTS),
    });
    const posts = await emLotes(midias.data ?? [], PARALELO, async (m): Promise<MktPost> => ({
      id: m.id,
      tipo: m.media_type,
      produto: m.media_product_type,
      data: m.timestamp,
      link: m.permalink,
      legenda: (m.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      curtidas: m.like_count ?? 0,
      comentarios: m.comments_count ?? 0,
      ...(await insightsDo(token, m.id)),
    }));
    let online: MktContaMetricas['online'];
    try {
      const r = await graph<Online>(token, `${c.igUserId}/insights`, { metric: 'online_followers', period: 'lifetime' });
      if (process.argv.includes('--sonda-horarios'))
        console.log(`[mkt] ${c.nome} online_followers: ${JSON.stringify((r.data?.[0]?.values ?? []).map((v) => ({ fim: v.end_time, horas: Object.keys(v.value ?? {}).length })))}`);
      const porDia = juntarOnline(r, anterior?.online?.porDia);
      online = Object.keys(porDia).length ? { porDia, atualizadoEm: new Date().toISOString() } : anterior?.online;
    } catch {
      online = anterior?.online; // sem a métrica, fica a última boa
    }
    const seguidores = perfil.followers_count ?? 0;
    return {
      ...base,
      usuario: perfil.username,
      seguidores,
      totalPosts: perfil.media_count,
      historico: registrarSeguidores(base.historico, diaSP(), seguidores),
      posts,
      ...(online ? { online } : {}),
    };
  } catch (e) {
    // Mantém os números da última coleta boa e mostra o erro na janela.
    return { ...base, usuario: anterior?.usuario, seguidores: anterior?.seguidores, totalPosts: anterior?.totalPosts, erro: e instanceof GraphErro ? e.message : 'falha na coleta' };
  }
}

export async function coletar(): Promise<MktMetricasFile> {
  const token = lerToken();
  let config = lerJson<MktConfig>(ARQ.config);
  if (!config?.contas?.length) {
    config = await descobrirContas(token);
    gravar(ARQ.config, config);
    console.log(`[mkt] config criada com ${config.contas.length} conta(s): ${config.contas.map((c) => c.nome).join(', ')}`);
  }
  const anterior = lerJson<MktMetricasFile>(ARQ.metricas);
  const contas: MktContaMetricas[] = [];
  for (const c of config.contas) contas.push(await coletarConta(token, c, anterior?.contas.find((x) => x.id === c.id)));
  const arquivo: MktMetricasFile = { atualizadoEm: new Date().toISOString(), contas };
  gravar(ARQ.metricas, arquivo);
  for (const c of contas) console.log(`[mkt] ${c.nome}: ${c.erro ? `ERRO ${c.erro}` : `${c.seguidores} seguidores, ${c.posts.length} posts lidos`}`);
  return arquivo;
}

async function daemon(): Promise<void> {
  const rodar = async () => {
    const ultima = lerJson<MktMetricasFile>(ARQ.metricas);
    if (ultima && Date.now() - Date.parse(ultima.atualizadoEm) < INTERVALO_MS) return;
    try {
      await coletar();
    } catch (e) {
      console.log(`[mkt] ${new Date().toISOString()} falhou: ${(e as Error).message}`);
    }
  };
  await rodar();
  setInterval(() => void rodar(), CHECAGEM_MS);
}

if (process.argv[1] && /marketing-collect/.test(process.argv[1])) {
  const run = process.argv.includes('--daemon') ? daemon() : coletar().then(() => undefined);
  run.catch((e) => {
    console.error(`[mkt] ${(e as Error).message}`);
    process.exit(1);
  });
}
