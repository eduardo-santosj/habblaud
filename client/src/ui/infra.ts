// Sala de Infra (fork Vela): janela com a saúde de cada sistema (semáforo), os alertas e o custo da AWS por mês.
// Dados de GET /api/infra (o coletor do host grava; o servidor só lê). O botão da barra superior mostra uma
// bolinha com a pior cor do momento, então dá para ver o estado sem abrir a janela. Sem /api/infra (modo por
// projeto, ou acesso remoto), o botão nem aparece.
// Gráfico em DOM puro: barras empilhadas finas por mês, uma cor por grupo (ordem fixa, paleta validada no escuro),
// legenda sempre visível, total escrito em cima de cada barra, dica no hover e tabela equivalente.
import type { InfraCor, InfraCustoFile, InfraGrupoConfig, InfraProdutoStatus, InfraSnapshot } from '../../../shared/infra';
import type { UiComponent, UiContext } from './context';
import { h, iconButton } from './dom';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

/** Id da sala fixa de Infra no modo por área (server/maestri.ts: areaRoomId('Infra')). */
export const INFRA_ROOM_ID = '/areas/Infra';

const PRIMEIRA_CONSULTA_MS = 1_500;
const POLL_FECHADO_MS = 60_000;
const POLL_ABERTO_MS = 20_000;

/** Ordem fixa das séries (nunca recicla): azul, laranja, verde-água, amarelo, magenta, violeta, vermelho. */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767'];

const ROTULO: Record<InfraCor, string> = { verde: 'No ar', amarelo: 'Atenção', vermelho: 'Fora', cinza: 'Sem dado' };
const PESO: Record<InfraCor, number> = { cinza: 0, verde: 1, amarelo: 2, vermelho: 3 };

/** Ícone da barra: um servidor em pixels com a bolinha de estado ao lado. */
const INFRA_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M1 1h7v3H1zM1 6h7v3H1z"/><path fill="var(--infra-led, transparent)" d="M8 0h2v2H8z"/>' +
  '<path fill="#000" fill-opacity=".45" d="M2 2h1v1H2zM2 7h1v1H2z"/></svg>';

const usd = (v: number) => `US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesCurto = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1] ?? m}/${m.slice(2, 4)}`;
const horaCurta = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';

/** Pior cor entre os produtos (o que a bolinha da barra mostra). */
export function piorCor(produtos: readonly InfraProdutoStatus[]): InfraCor {
  let pior: InfraCor = 'cinza';
  for (const p of produtos) if (PESO[p.cor] > PESO[pior]) pior = p.cor;
  return produtos.length ? pior : 'cinza';
}

async function buscar(): Promise<InfraSnapshot | null> {
  const res = await fetch('/api/infra', { cache: 'no-store' });
  if (!res || res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(tr('erro {0}', [res.status]));
  return (await res.json()) as InfraSnapshot;
}

export class InfraLauncher implements UiComponent {
  readonly button: HTMLButtonElement;
  private readonly el: HTMLDialogElement;
  private readonly corpo: HTMLElement;
  private readonly sub: HTMLElement;
  private dados: InfraSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: UiContext,
    mount: (el: HTMLElement) => void,
  ) {
    this.button = iconButton(INFRA_ICON, tr('Infra: sistemas no ar e custo da nuvem'), () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.hidden = true;

    this.sub = h('p', { class: 'ui-infra__sub' });
    this.corpo = h('div', { class: 'ui-infra__body' });
    const fechar = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.el.close(), 'ui-icon-btn--sm');
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-infra', attrs: { 'aria-labelledby': 'ui-infra-title' } },
      h('div', { class: 'ui-dialog__head' }, h('div', {}, h('h2', { text: tr('Sala de Infra'), attrs: { id: 'ui-infra-title' } }), this.sub), fechar),
      this.corpo,
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => {
      this.button.setAttribute('aria-expanded', 'false');
      this.agendar();
    });
    mount(this.el);
    // Primeira consulta um pouco depois da montagem: não disputa a rede com o que o escritório carrega ao abrir.
    this.timer = setTimeout(() => void this.atualizar(), PRIMEIRA_CONSULTA_MS);
  }

  toggle(): void {
    if (this.el.open) this.el.close();
    else {
      this.el.showModal();
      this.button.setAttribute('aria-expanded', 'true');
      void this.atualizar();
    }
  }

  render(): void {
    // Atualiza por conta própria (não depende do snapshot do escritório).
  }

  private agendar(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.atualizar(), this.el.open ? POLL_ABERTO_MS : POLL_FECHADO_MS);
  }

  private async atualizar(): Promise<void> {
    try {
      this.dados = await buscar();
      this.button.hidden = this.dados === null;
      if (this.dados) {
        const cor = piorCor(this.dados.status?.produtos ?? []);
        this.button.dataset.infra = cor;
        this.button.title = `${tr('Infra')}: ${ROTULO[cor]}${this.dados.alertas.length ? ` · ${this.dados.alertas.length} alerta(s)` : ''}`;
        if (this.el.open) this.desenhar(this.dados);
      }
    } catch {
      if (this.el.open) this.corpo.replaceChildren(h('p', { class: 'ui-infra__vazio', text: tr('Não foi possível ler a sala de Infra agora. Tento de novo em instantes.') }));
    } finally {
      this.agendar();
    }
  }

  private desenhar(d: InfraSnapshot): void {
    this.sub.textContent = `${tr('Sistemas verificados')} ${horaCurta(d.status?.verificadoEm)} · ${tr('custo de')} ${horaCurta(d.custo?.atualizadoEm)}`;
    if (!d.configurado) {
      this.corpo.replaceChildren(h('p', { class: 'ui-infra__vazio', text: tr('Falta a configuração do coletor (infra/config.json na pasta de uso do Habblaud).') }));
      return;
    }
    this.corpo.replaceChildren(this.semaforo(d.status?.produtos ?? []), this.alertas(d), this.custo(d.custo));
  }

  private semaforo(produtos: InfraProdutoStatus[]): HTMLElement {
    const lista = h('ul', { class: 'ui-infra__grid' });
    for (const p of produtos) {
      lista.append(
        h(
          'li',
          { class: `ui-infra__card is-${p.cor}`, title: p.detalhe },
          h('span', { class: 'ui-infra__led', attrs: { 'aria-hidden': 'true' } }),
          h('div', { class: 'ui-infra__card-txt' }, h('strong', { text: p.nome }), h('span', { class: 'ui-infra__estado', text: ROTULO[p.cor] }), h('small', { text: p.detalhe })),
        ),
      );
    }
    if (!produtos.length) lista.append(h('li', { class: 'ui-infra__vazio', text: tr('O coletor ainda não rodou.') }));
    return h('section', { class: 'ui-infra__sec' }, h('h3', { text: tr('Agora') }), lista);
  }

  private alertas(d: InfraSnapshot): HTMLElement {
    const sec = h('section', { class: 'ui-infra__sec' }, h('h3', { text: tr('Alertas') }));
    if (!d.alertas.length) {
      sec.append(h('p', { class: 'ui-infra__ok', text: tr('Nenhum alerta: tudo dentro do esperado.') }));
      return sec;
    }
    const ul = h('ul', { class: 'ui-infra__alertas' });
    for (const a of d.alertas) {
      const rot = a.nivel === 'critico' ? tr('Crítico') : a.nivel === 'aviso' ? tr('Aviso') : tr('Info');
      ul.append(h('li', { class: `is-${a.nivel}` }, h('span', { class: 'ui-infra__tag', text: rot }), h('span', { text: a.texto })));
    }
    sec.append(ul);
    return sec;
  }

  private custo(c: InfraCustoFile | null): HTMLElement {
    const sec = h('section', { class: 'ui-infra__sec' }, h('h3', { text: tr('Custo da nuvem (AWS)') }));
    if (!c || !c.meses.length) {
      sec.append(h('p', { class: 'ui-infra__vazio', text: tr('O custo ainda não foi coletado (roda segunda e quinta).') }));
      return sec;
    }
    const pagadores = [...new Set(c.grupos.map((g) => g.pagador ?? tr('Sem pagador')))];
    const principal = pagadores.includes('Vela') ? 'Vela' : pagadores[0];
    const somaPag = (porGrupo: Record<string, number>, pag: string) =>
      c.grupos.filter((g) => (g.pagador ?? tr('Sem pagador')) === pag).reduce((s, g) => s + (porGrupo[g.id] ?? 0), 0);
    const fechados = c.meses.filter((m) => !m.parcial);
    const ultimo = fechados[fechados.length - 1];
    const atual = c.meses.find((m) => m.parcial);

    // Números de destaque: quem paga, este mês (projeção) e o mês passado.
    const tiles = h('div', { class: 'ui-infra__tiles' });
    for (const pag of pagadores) {
      const proj = c.projecao ? somaPag(c.projecao.porGrupo, pag) : atual ? somaPag(atual.porGrupo, pag) : 0;
      const ant = ultimo ? somaPag(ultimo.porGrupo, pag) : 0;
      tiles.append(
        h(
          'div',
          { class: `ui-infra__tile${pag === principal ? ' is-principal' : ''}` },
          h('span', { class: 'ui-infra__tile-k', text: pag === principal ? `${tr('A')} ${pag} ${tr('paga')}` : `${pag} ${tr('paga (cliente)')}` }),
          h('strong', { text: usd(proj) }),
          h('span', { class: 'ui-infra__tile-s', text: `${c.projecao ? tr('projeção deste mês') : tr('este mês até agora')} · ${tr('mês passado')} ${usd(ant)}` }),
        ),
      );
    }
    sec.append(tiles, this.grafico(c), this.tabela(c));
    sec.append(h('p', { class: 'ui-infra__nota', text: tr('Valores em dólar, sem conversão. Máquinas que dividem a mesma instância aparecem juntas; IP, disco e imposto são rateados. O mês atual mostra o gasto até ontem e, em contorno, a projeção.') }));
    return sec;
  }

  private grafico(c: InfraCustoFile): HTMLElement {
    const proj = c.projecao;
    const max = Math.max(1, ...c.meses.map((m) => Math.max(m.total, m.parcial && proj?.mes === m.mes ? proj.total : 0)));
    const cor = new Map(c.grupos.map((g, i) => [g.id, SERIES[i % SERIES.length]]));
    const colunas = h('div', { class: 'ui-infra__chart', role: 'img', attrs: { 'aria-label': tr('Custo por mês e por produto; os mesmos números estão na tabela abaixo.') } });
    for (const m of c.meses) {
      const alvo = m.parcial && proj?.mes === m.mes ? proj.total : m.total;
      const col = h('div', { class: `ui-infra__col${m.parcial ? ' is-parcial' : ''}` });
      const pilha = h('div', { class: 'ui-infra__stack', style: `height:${(alvo / max) * 100}%` });
      if (m.parcial && proj?.mes === m.mes) pilha.classList.add('has-proj');
      const real = h('div', { class: 'ui-infra__real', style: `height:${alvo > 0 ? (m.total / alvo) * 100 : 0}%` });
      for (const g of c.grupos) {
        const v = m.porGrupo[g.id] ?? 0;
        if (v <= 0) continue;
        real.append(h('span', { class: 'ui-infra__seg', style: `flex:${v};--sw:${cor.get(g.id)}`, title: `${mesCurto(m.mes)} · ${g.nome}: ${usd(v)}` }));
      }
      pilha.append(real);
      col.append(
        h('span', { class: 'ui-infra__val', text: usd(alvo).replace('US$ ', '') }),
        h('div', { class: 'ui-infra__bar' }, pilha),
        h('span', { class: 'ui-infra__mes', text: m.parcial ? `${mesCurto(m.mes)}*` : mesCurto(m.mes) }),
      );
      colunas.append(col);
    }
    const legenda = h('ul', { class: 'ui-infra__legenda' });
    for (const g of c.grupos) legenda.append(h('li', {}, h('span', { class: 'ui-infra__sw', style: `--sw:${cor.get(g.id)}` }), h('span', { text: rotuloGrupo(g) })));
    return h('div', { class: 'ui-infra__chartbox' }, colunas, legenda);
  }

  private tabela(c: InfraCustoFile): HTMLElement {
    const head = h('tr', {}, h('th', { text: tr('Produto') }), ...c.meses.map((m) => h('th', { text: m.parcial ? `${mesCurto(m.mes)}*` : mesCurto(m.mes) })));
    if (c.projecao) head.append(h('th', { text: tr('projeção') }));
    const linhas = c.grupos.map((g) =>
      h('tr', {}, h('th', { text: rotuloGrupo(g) }), ...c.meses.map((m) => h('td', { text: (m.porGrupo[g.id] ?? 0).toFixed(2) })), ...(c.projecao ? [h('td', { text: (c.projecao.porGrupo[g.id] ?? 0).toFixed(2) })] : [])),
    );
    const total = h('tr', { class: 'is-total' }, h('th', { text: tr('Total') }), ...c.meses.map((m) => h('td', { text: m.total.toFixed(2) })), ...(c.projecao ? [h('td', { text: c.projecao.total.toFixed(2) })] : []));
    return h('details', { class: 'ui-infra__tabela' }, h('summary', { text: tr('Ver em tabela (US$)') }), h('table', {}, h('thead', {}, head), h('tbody', {}, ...linhas, total)));
  }
}

function rotuloGrupo(g: InfraGrupoConfig): string {
  return g.pagador && g.pagador !== 'Vela' ? `${g.nome} (${tr('paga')}: ${g.pagador})` : g.nome;
}
