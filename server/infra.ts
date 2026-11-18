// Sala de Infra (fork Vela): lê o que o coletor do host grava em <usageDir>/infra/ (status.json, custo.json e a
// config.json, para os limites) e monta o que GET /api/infra devolve. Relê só quando o arquivo muda. Nunca lança.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gerarAlertas, type InfraConfig, type InfraCustoFile, type InfraSnapshot, type InfraStatusFile } from '../shared/infra';

class ArquivoJson<T> {
  private mtimeMs = -1;
  private valor: T | null = null;

  constructor(private readonly arq: string) {}

  get existe(): boolean {
    try {
      statSync(this.arq);
      return true;
    } catch {
      return false;
    }
  }

  ler(): T | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.arq).mtimeMs;
    } catch {
      return null;
    }
    if (mtimeMs !== this.mtimeMs) {
      try {
        this.valor = JSON.parse(readFileSync(this.arq, 'utf8')) as T;
        this.mtimeMs = mtimeMs;
      } catch {
        // gravação pela metade: fica com o último bom
      }
    }
    return this.valor;
  }
}

export class InfraService {
  private status: ArquivoJson<InfraStatusFile>;
  private custo: ArquivoJson<InfraCustoFile>;
  private config: ArquivoJson<InfraConfig>;

  constructor(usageDir: string) {
    const dir = join(usageDir, 'infra');
    this.status = new ArquivoJson(join(dir, 'status.json'));
    this.custo = new ArquivoJson(join(dir, 'custo.json'));
    this.config = new ArquivoJson(join(dir, 'config.json'));
  }

  snapshot(agora = Date.now()): InfraSnapshot {
    const status = this.status.ler();
    const custo = this.custo.ler();
    const config = this.config.ler();
    return { configurado: this.config.existe, status, custo, alertas: gerarAlertas(status, custo, config, agora) };
  }
}
