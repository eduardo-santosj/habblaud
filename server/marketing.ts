// Sala de Marketing (fork Vela): lê o que o coletor do host grava em <usageDir>/marketing/ (metricas.json e
// config.json) e as pautas em marketing/pauta/<segunda>.json; aplica a decisão do dono (roteiro ou arte) num item
// da pauta e entrega a mídia da arte (marketing/midia/<semana>/<id>/<arquivo>) para a prévia.
// O servidor nunca fala com a Meta e nunca vê o token: só lê e escreve esses arquivos.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contarPendentes,
  decidir,
  decidirArte,
  diaSP,
  ITEM_ID_RE,
  tipoDaMidia,
  gerarAlertasMkt,
  resumirConta,
  segundaDe,
  type MktConfig,
  type MktMetricasFile,
  type MktPautaFile,
  type MktResumoConta,
  type MktSnapshot,
} from '../shared/marketing';
import { ArquivoJson } from './infra';

const SEMANA_RE = /^\d{4}-\d{2}-\d{2}$/;

export class MarketingService {
  private readonly dir: string;
  private readonly pautaDir: string;
  private readonly metricas: ArquivoJson<MktMetricasFile>;
  private readonly config: ArquivoJson<MktConfig>;

  constructor(usageDir: string) {
    this.dir = join(usageDir, 'marketing');
    this.pautaDir = join(this.dir, 'pauta');
    this.metricas = new ArquivoJson(join(this.dir, 'metricas.json'));
    this.config = new ArquivoJson(join(this.dir, 'config.json'));
  }

  /** Pautas da semana atual em diante (a passada some da janela; o arquivo continua no disco). */
  private pautas(agora: number): MktPautaFile[] {
    const atual = segundaDe(diaSP(agora));
    let nomes: string[] = [];
    try {
      nomes = readdirSync(this.pautaDir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: MktPautaFile[] = [];
    for (const n of nomes.sort()) {
      const semana = n.slice(0, -5);
      if (!SEMANA_RE.test(semana) || semana < atual) continue;
      const p = this.lerPauta(semana);
      if (p) out.push(p);
    }
    return out;
  }

  private lerPauta(semana: string): MktPautaFile | null {
    try {
      const p = JSON.parse(readFileSync(join(this.pautaDir, `${semana}.json`), 'utf8')) as MktPautaFile;
      return Array.isArray(p?.itens) ? { ...p, semana } : null;
    } catch {
      return null;
    }
  }

  snapshot(agora = Date.now()): MktSnapshot {
    const metricas = this.metricas.ler();
    const pautas = this.pautas(agora);
    const resumo: Record<string, MktResumoConta> = {};
    for (const c of metricas?.contas ?? []) resumo[c.id] = resumirConta(c);
    return {
      configurado: this.config.existe,
      metricas,
      resumo,
      pautas,
      pendentes: contarPendentes(pautas),
      alertas: gerarAlertasMkt(metricas, pautas, agora),
    };
  }

  /** Decisão do dono num item (etapa "roteiro" ou "arte"). Lança Error com o motivo (vira 400/404 na rota). */
  decidir(semana: string, id: string, status: string, nota?: string, etapa: string = 'roteiro'): MktPautaFile {
    if (!SEMANA_RE.test(semana)) throw new Error('semana inválida');
    if (etapa !== 'roteiro' && etapa !== 'arte') throw new Error('etapa inválida');
    const atual = this.lerPauta(semana);
    if (!atual) throw new Error('pauta não encontrada');
    const nova = etapa === 'arte' ? decidirArte(atual, id, status, nota) : decidir(atual, id, status, nota);
    mkdirSync(this.pautaDir, { recursive: true });
    const arq = join(this.pautaDir, `${semana}.json`);
    const tmp = `${arq}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(nova, null, 2)}\n`);
    renameSync(tmp, arq);
    return nova;
  }

  /** Arquivo da arte para a prévia. Só nomes simples de imagem ou vídeo; qualquer outra coisa vira null (404). */
  midia(semana: string, id: string, nome: string): { caminho: string; tipo: string; tamanho: number } | null {
    const tipo = tipoDaMidia(nome);
    if (!tipo || !SEMANA_RE.test(semana) || !ITEM_ID_RE.test(id)) return null;
    const caminho = join(this.dir, 'midia', semana, id, nome);
    try {
      const st = statSync(caminho);
      return st.isFile() ? { caminho, tipo, tamanho: st.size } : null;
    } catch {
      return null;
    }
  }
}
