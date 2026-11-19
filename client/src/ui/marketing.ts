// Sala de Marketing (fork Vela): janela com os números das contas do Instagram, a pauta da semana para o dono
// aprovar em lote e os últimos posts. Dados de GET /api/marketing (o coletor do host grava; o servidor só lê).
// Decisões vão por POST /api/marketing/decidir, só no próprio computador. Nada é publicado daqui.
// Duas etapas: o dono aprova o roteiro; o produtor (fora daqui) faz a arte e a janela mostra a prévia
// (GET /api/marketing/midia/...) para o dono aprovar ou pedir ajuste.
// O botão da barra mostra um ponto quando há post esperando aprovação. Sem a rota (modo por projeto, acesso
// remoto), o botão nem aparece.
import type { MktArte, MktArteStatus, MktContaMetricas, MktResumoConta, MktDecisao, MktDecisaoArte, MktFormato, MktPautaFile, MktPautaItem, MktPost, MktSnapshot, MktStatus } from '../../../shared/marketing';
import { ehVideo, engajamento, interacoesDo, momentoDoPost } from '../../../shared/marketing';
import type { UiComponent, UiContext } from './context';
import { h, iconButton } from './dom';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

/** Id da sala fixa de Marketing no modo por área (server/maestri.ts: areaRoomId('Marketing')). */
export const MARKETING_ROOM_ID = '/areas/Marketing';

const PRIMEIRA_CONSULTA_MS = 2_000;
const POLL_FECHADO_MS = 120_000;
const POLL_ABERTO_MS = 30_000;
const POSTS_NA_TELA = 8;

/** Ícone da barra: um megafone em pixels com o ponto de pendência no canto. */
const MKT_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M1 4h2v3H1zM3 3h1v5H3zM4 2h1v7H4zM5 1h1v9H5zM2 7h1v2H2z"/><path fill="var(--mkt-led, transparent)" d="M8 0h2v2H8z"/>' +
  '<path fill="currentColor" d="M7 4h1v1H7zM7 6h1v1H7z"/></svg>';

const FORMATO: Record<MktFormato, string> = { reels: 'Reels', carrossel: 'Carrossel', post: 'Post', story: 'Story' };
const STATUS: Record<MktStatus, string> = { proposta: 'Esperando você', aprovado: 'Roteiro aprovado', ajustar: 'Ajustar', descartado: 'Descartado', publicado: 'Publicado' };
const ARTE: Record<MktArteStatus, string> = {
  produzindo: 'Produzindo a arte. Aparece aqui quando ficar pronta.',
  pronta: 'Arte pronta: confira e aprove.',
  aprovada: 'Arte aprovada. Pode ir para publicação.',
  ajustar: 'Refazendo a arte com o seu ajuste.',
  falhou: 'A arte não saiu.',
};

type Etapa = 'roteiro' | 'arte' | 'postagem';
type Decisao = { id: string; status: MktDecisao | MktDecisaoArte | 'publicado'; nota?: string };
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const num = (v?: number) => (typeof v === 'number' ? Math.round(v).toLocaleString('pt-BR') : '-');
const pct = (v?: number) => (typeof v === 'number' ? `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '-');
const diaCurto = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
const diaSemana = (dia: string) => `${DIAS[new Date(`${dia}T12:00:00Z`).getUTCDay()]} ${diaCurto(dia)}`;
const horaCurta = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
const dataPost = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });

/** Melhores horas de postar, em texto curto (curva plana vira "sem hora de destaque, bom das X às Y"). */
function horariosTexto(hz?: MktResumoConta['horarios']): string {
  if (!hz) return tr('Melhor horário: a Meta só mede a partir de 100 seguidores.');
  const base = `${tr('Seguidores online')} (${hz.dias} ${hz.dias === 1 ? tr('dia') : tr('dias')})`;
  if (!hz.destaca) {
    const pico = Math.max(...hz.media);
    const fortes = hz.media.map((n, h) => [h, n] as const).filter(([h, n]) => h >= 7 && n >= pico * 0.9).map(([h]) => h);
    return `${base}: ${tr('sem hora de destaque, bom das')} ${Math.min(...fortes)}h ${tr('às')} ${Math.max(...fortes)}h`;
  }
  return `${base}: ${tr('melhores')} ${hz.melhores.map((h) => `${h}h`).join(', ')}`;
}

async function buscar(): Promise<MktSnapshot | null> {
  const res = await fetch('/api/marketing', { cache: 'no-store' });
  if (!res || res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(tr('erro {0}', [res.status]));
  return (await res.json()) as MktSnapshot;
}

async function enviarDecisao(semana: string, etapa: Etapa, d: Decisao): Promise<void> {
  const res = await fetch('/api/marketing/decidir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ semana, etapa, ...d }) });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? tr('erro {0}', [res.status]));
  }
}

export class MarketingLauncher implements UiComponent {
  readonly button: HTMLButtonElement;
  private readonly el: HTMLDialogElement;
  private readonly corpo: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly aviso: HTMLElement;
  private dados: MktSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Caixa de ajuste aberta ("<id>" no roteiro, "arte:<id>" na arte); sobrevive ao redesenho do poll. */
  private ajustando: string | null = null;
  /** Assinatura do último snapshot desenhado: sem mudança, não redesenha (não corta o vídeo da prévia). */
  private desenhado = '';
  /** Item com o "Já postei" esperando a confirmação (segundo clique). */
  private confirmandoPost: string | null = null;
  private ocupado = false;

  constructor(
    private readonly ctx: UiContext,
    mount: (el: HTMLElement) => void,
  ) {
    this.button = iconButton(MKT_ICON, tr('Marketing: contas, pauta e aprovação'), () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.hidden = true;

    this.sub = h('p', { class: 'ui-infra__sub' });
    this.aviso = h('p', { class: 'ui-mkt__aviso', role: 'status', hidden: true });
    this.corpo = h('div', { class: 'ui-infra__body' });
    const fechar = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.el.close(), 'ui-icon-btn--sm');
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-infra ui-mkt', attrs: { 'aria-labelledby': 'ui-mkt-title' } },
      h('div', { class: 'ui-dialog__head' }, h('div', {}, h('h2', { text: tr('Sala de Marketing'), attrs: { id: 'ui-mkt-title' } }), this.sub), fechar),
      this.aviso,
      this.corpo,
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => {
      this.button.setAttribute('aria-expanded', 'false');
      this.ajustando = null;
      this.desenhado = '';
      this.agendar();
    });
    mount(this.el);
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
        const n = this.dados.pendentes;
        if (n) this.button.dataset.mkt = 'pendente';
        else delete this.button.dataset.mkt;
        this.button.title = `${tr('Marketing')}${n ? ` · ${n} ${tr('esperando aprovação')}` : ''}`;
        // Não redesenha com a caixa de ajuste aberta (apagaria o que está sendo digitado), com vídeo tocando,
        // nem quando nada mudou.
        const tocando = [...this.el.querySelectorAll('video')].some((v) => !v.paused);
        if (this.el.open && !this.ajustando && !tocando) this.desenhar(this.dados);
      }
    } catch {
      if (this.el.open) this.corpo.replaceChildren(h('p', { class: 'ui-infra__vazio', text: tr('Não foi possível ler a sala de Marketing agora. Tento de novo em instantes.') }));
    } finally {
      this.agendar();
    }
  }

  private mostrarAviso(texto: string | null): void {
    this.aviso.hidden = !texto;
    this.aviso.textContent = texto ?? '';
  }

  private async decidirItens(semana: string, itens: Decisao[], etapa: Etapa = 'roteiro'): Promise<void> {
    if (this.ocupado) return;
    this.ocupado = true;
    this.mostrarAviso(null);
    try {
      for (const it of itens) await enviarDecisao(semana, etapa, it);
      this.ajustando = null;
      this.desenhado = '';
    } catch (e) {
      this.mostrarAviso(`${tr('Não salvou')}: ${(e as Error).message}`);
    } finally {
      this.ocupado = false;
      await this.atualizar();
    }
  }

  private redesenhar(): void {
    this.desenhado = '';
    if (this.dados) this.desenhar(this.dados);
  }

  private desenhar(d: MktSnapshot): void {
    const assinatura = JSON.stringify(d);
    if (assinatura === this.desenhado) return;
    this.desenhado = assinatura;
    this.sub.textContent = `${tr('Números do Instagram de')} ${horaCurta(d.metricas?.atualizadoEm)} · ${tr('nada é publicado sem a sua aprovação')}`;
    if (!d.configurado && !d.metricas) {
      this.corpo.replaceChildren(h('p', { class: 'ui-infra__vazio', text: tr('O coletor do Instagram ainda não rodou (npm run mkt:coletar no computador).') }));
      return;
    }
    const contas = d.metricas?.contas ?? [];
    const nomes = new Map(contas.map((c) => [c.id, c.nome]));
    this.corpo.replaceChildren(this.contas(d, contas), ...(d.alertas.length ? [this.alertas(d)] : []), this.pautas(d.pautas, nomes), this.posts(contas));
  }

  private contas(d: MktSnapshot, contas: MktContaMetricas[]): HTMLElement {
    const tiles = h('div', { class: 'ui-infra__tiles' });
    for (const c of contas) {
      const r = d.resumo[c.id] ?? {};
      const ganho = r.ganho7d === undefined ? tr('crescimento: medindo a partir de hoje') : `${r.ganho7d >= 0 ? '+' : ''}${r.ganho7d} ${tr('em 7 dias')}`;
      tiles.append(
        h(
          'div',
          { class: 'ui-infra__tile' },
          h('span', { class: 'ui-infra__tile-k', text: `${c.nome}${c.usuario ? ` · @${c.usuario}` : ''}` }),
          h('strong', { text: `${num(c.seguidores)} ${tr('seguidores')}` }),
          h('span', { class: 'ui-infra__tile-s', text: ganho }),
          h('span', { class: 'ui-infra__tile-s', text: `${tr('Últimos 10 posts')}: ${tr('alcance médio')} ${num(r.alcanceMedio)} · ${tr('engajamento')} ${pct(r.engajamentoMedio)}` }),
          h('span', { class: 'ui-infra__tile-s', text: horariosTexto(r.horarios) }),
          ...(c.erro ? [h('span', { class: 'ui-mkt__erro', text: c.erro })] : []),
        ),
      );
    }
    if (!contas.length) tiles.append(h('p', { class: 'ui-infra__vazio', text: tr('Nenhuma conta coletada ainda.') }));
    return h('section', { class: 'ui-infra__sec' }, h('h3', { text: tr('Contas') }), tiles);
  }

  private alertas(d: MktSnapshot): HTMLElement {
    const ul = h('ul', { class: 'ui-infra__alertas' });
    for (const a of d.alertas) ul.append(h('li', { class: `is-${a.nivel}` }, h('span', { class: 'ui-infra__tag', text: a.nivel === 'aviso' ? tr('Aviso') : tr('Info') }), h('span', { text: a.texto })));
    return h('section', { class: 'ui-infra__sec' }, h('h3', { text: tr('Alertas') }), ul);
  }

  private pautas(pautas: MktPautaFile[], nomes: Map<string, string>): HTMLElement {
    const sec = h('section', { class: 'ui-infra__sec' }, h('h3', { text: tr('Pauta') }));
    if (!pautas.length) {
      sec.append(h('p', { class: 'ui-infra__vazio', text: tr('Nenhuma pauta montada para esta semana ou a próxima.') }));
      return sec;
    }
    for (const p of pautas) {
      const propostas = p.itens.filter((i) => i.status === 'proposta');
      const artes = p.itens.filter((i) => i.status === 'aprovado' && i.arte?.status === 'pronta');
      const cab = h('div', { class: 'ui-mkt__semana' }, h('h4', { text: `${tr('Semana de')} ${diaCurto(p.semana)}` }));
      if (propostas.length > 1) {
        cab.append(
          h('button', {
            class: 'ui-btn ui-btn--primary ui-btn--sm',
            type: 'button',
            text: `${tr('Aprovar os')} ${propostas.length} ${tr('roteiros')}`,
            on: { click: () => void this.decidirItens(p.semana, propostas.map((i) => ({ id: i.id, status: 'aprovado' as const }))) },
          }),
        );
      }
      if (artes.length > 1) {
        cab.append(
          h('button', {
            class: 'ui-btn ui-btn--primary ui-btn--sm',
            type: 'button',
            text: `${tr('Aprovar as')} ${artes.length} ${tr('artes')}`,
            on: { click: () => void this.decidirItens(p.semana, artes.map((i) => ({ id: i.id, status: 'aprovada' as const })), 'arte') },
          }),
        );
      }
      const lista = h('ol', { class: 'ui-mkt__itens' });
      for (const it of [...p.itens].sort((a, b) => `${a.dia}${a.hora ?? ''}`.localeCompare(`${b.dia}${b.hora ?? ''}`))) lista.append(this.item(p.semana, it, nomes));
      sec.append(cab, lista);
    }
    return sec;
  }

  private item(semana: string, it: MktPautaItem, nomes: Map<string, string>): HTMLElement {
    const li = h('li', { class: `ui-mkt__item is-${it.status}` });
    li.append(
      h(
        'div',
        { class: 'ui-mkt__item-cab' },
        h('span', { class: 'ui-mkt__quando', text: `${diaSemana(it.dia)}${it.hora ? ` · ${it.hora}` : ''}` }),
        h('span', { class: 'ui-mkt__chip', text: nomes.get(it.conta) ?? it.conta }),
        h('span', { class: 'ui-mkt__chip', text: FORMATO[it.formato] ?? it.formato }),
        h('span', { class: `ui-mkt__status is-${it.status}`, text: STATUS[it.status] ?? it.status }),
      ),
      h('strong', { class: 'ui-mkt__tema', text: it.tema }),
    );
    if (it.porque) li.append(h('p', { class: 'ui-mkt__porque', text: it.porque }));
    const det = h('details', { class: 'ui-mkt__det' }, h('summary', { text: tr('Roteiro e legenda') }));
    if (it.roteiro) det.append(h('h5', { text: tr('Roteiro') }), h('p', { class: 'ui-mkt__texto', text: it.roteiro }));
    det.append(h('h5', { text: tr('Legenda') }), h('p', { class: 'ui-mkt__texto', text: it.legenda }));
    li.append(det);
    if (it.nota) li.append(h('p', { class: 'ui-mkt__nota', text: `${tr('Seu ajuste')}: ${it.nota}` }));
    if (it.status === 'publicado') {
      li.append(h('p', { class: 'ui-mkt__arte-st', text: `${tr('Postado em')} ${horaCurta(it.publicadoEm)}` }));
      return li;
    }

    const acoes = h('div', { class: 'ui-mkt__acoes' });
    const botao = (texto: string, status: MktDecisao, primario = false) =>
      h('button', { class: `ui-btn ui-btn--sm${primario ? ' ui-btn--primary' : ''}`, type: 'button', text: texto, on: { click: () => void this.decidirItens(semana, [{ id: it.id, status }]) } });
    if (it.status !== 'aprovado') acoes.append(botao(tr('Aprovar'), 'aprovado', true));
    if (it.status !== 'ajustar' || this.ajustando !== it.id)
      acoes.append(
        h('button', {
          class: 'ui-btn ui-btn--sm',
          type: 'button',
          text: tr('Pedir ajuste'),
          on: {
            click: () => {
              this.ajustando = it.id;
              this.redesenhar();
            },
          },
        }),
      );
    if (it.status !== 'descartado') acoes.append(botao(tr('Descartar'), 'descartado'));
    if (it.status !== 'proposta') acoes.append(botao(tr('Voltar a proposta'), 'proposta'));
    li.append(acoes);
    if (it.status === 'aprovado') li.append(this.arte(semana, it));

    if (this.ajustando === it.id) {
      const campo = h('textarea', { class: 'ui-mkt__campo', attrs: { rows: '3', maxlength: '1000', placeholder: tr('O que mudar? (ex.: trocar a capa, encurtar a legenda)'), 'aria-label': tr('O que ajustar') } });
      if (it.nota) campo.value = it.nota;
      const enviar = h('button', {
        class: 'ui-btn ui-btn--primary ui-btn--sm',
        type: 'button',
        text: tr('Enviar ajuste'),
        on: { click: () => void this.decidirItens(semana, [{ id: it.id, status: 'ajustar', nota: campo.value }]) },
      });
      const cancelar = h('button', {
        class: 'ui-btn ui-btn--sm',
        type: 'button',
        text: tr('Cancelar'),
        on: {
          click: () => {
            this.ajustando = null;
            this.redesenhar();
          },
        },
      });
      li.append(h('div', { class: 'ui-mkt__ajuste' }, campo, h('div', { class: 'ui-mkt__acoes' }, enviar, cancelar)));
      queueMicrotask(() => campo.focus());
    }
    return li;
  }

  /** Segunda etapa: estado da arte, prévia dos arquivos e a decisão do dono. */
  private arte(semana: string, it: MktPautaItem): HTMLElement {
    const a = it.arte;
    const box = h('div', { class: `ui-mkt__arte is-${a?.status ?? 'fila'}` }, h('h5', { text: tr('Arte') }));
    if (!a) {
      box.append(h('p', { class: 'ui-mkt__arte-st', text: tr('Na fila: a produção começa sozinha em instantes.') }));
      return box;
    }
    box.append(h('p', { class: 'ui-mkt__arte-st', text: tr(ARTE[a.status] ?? a.status) }));
    if (a.status === 'falhou' && a.erro) box.append(h('p', { class: 'ui-mkt__erro', text: a.erro }));
    if (a.nota) box.append(h('p', { class: 'ui-mkt__nota', text: `${tr('Seu ajuste na arte')}: ${a.nota}` }));
    if (a.arquivos.length && a.status !== 'produzindo') box.append(this.previa(semana, it.id, a));

    const acoes = h('div', { class: 'ui-mkt__acoes' });
    const botao = (texto: string, status: MktDecisaoArte, primario = false) =>
      h('button', { class: `ui-btn ui-btn--sm${primario ? ' ui-btn--primary' : ''}`, type: 'button', text: texto, on: { click: () => void this.decidirItens(semana, [{ id: it.id, status }], 'arte') } });
    const chave = `arte:${it.id}`;
    const pedirAjuste = () =>
      h('button', {
        class: 'ui-btn ui-btn--sm',
        type: 'button',
        text: tr('Pedir ajuste na arte'),
        on: {
          click: () => {
            this.ajustando = chave;
            this.redesenhar();
          },
        },
      });
    if (a.status === 'pronta') acoes.append(botao(tr('Aprovar arte'), 'aprovada', true), pedirAjuste());
    if (a.status === 'aprovada') acoes.append(pedirAjuste(), botao(tr('Voltar a conferir'), 'pronta'));
    if (a.status === 'aprovada') box.append(this.postagem(semana, it, a));
    if (a.status === 'falhou') acoes.append(botao(tr('Tentar de novo'), 'ajustar', true));
    if (acoes.childElementCount) box.append(acoes);

    if (this.ajustando === chave) {
      const campo = h('textarea', { class: 'ui-mkt__campo', attrs: { rows: '3', maxlength: '1000', placeholder: tr('O que mudar na arte? (ex.: logo maior, trocar a foto do slide 2)'), 'aria-label': tr('O que ajustar na arte') } });
      const enviar = h('button', {
        class: 'ui-btn ui-btn--primary ui-btn--sm',
        type: 'button',
        text: tr('Enviar ajuste'),
        on: { click: () => void this.decidirItens(semana, [{ id: it.id, status: 'ajustar', nota: campo.value }], 'arte') },
      });
      const cancelar = h('button', {
        class: 'ui-btn ui-btn--sm',
        type: 'button',
        text: tr('Cancelar'),
        on: {
          click: () => {
            this.ajustando = null;
            this.redesenhar();
          },
        },
      });
      box.append(h('div', { class: 'ui-mkt__ajuste' }, campo, h('div', { class: 'ui-mkt__acoes' }, enviar, cancelar)));
      queueMicrotask(() => campo.focus());
    }
    return box;
  }

  /** Kit para postar à mão: quando, legenda para copiar, arquivos para baixar e o "Já postei" (com confirmação). */
  private postagem(semana: string, it: MktPautaItem, a: MktArte): HTMLElement {
    const quando = momentoDoPost(it);
    const box = h('div', { class: 'ui-mkt__postar' }, h('h5', { text: tr('Para postar') }));
    box.append(
      h('p', {
        class: 'ui-mkt__arte-st',
        text: quando === null ? tr('Sem horário definido na pauta.') : `${tr('Postar')} ${diaSemana(it.dia)} ${tr('às')} ${it.hora}${Date.now() > quando ? ` · ${tr('passou da hora')}` : ''}`,
      }),
    );
    const copiar = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Copiar legenda') });
    copiar.addEventListener('click', () => {
      void navigator.clipboard.writeText(it.legenda).then(
        () => (copiar.textContent = tr('Legenda copiada')),
        () => this.mostrarAviso(tr('Não consegui copiar: selecione a legenda em "Roteiro e legenda".')),
      );
    });
    const arquivos = h('div', { class: 'ui-mkt__baixar' });
    for (const nome of a.arquivos) {
      const src = `/api/marketing/midia/${encodeURIComponent(semana)}/${encodeURIComponent(it.id)}/${encodeURIComponent(nome)}?v=${a.versao}`;
      arquivos.append(h('a', { class: 'ui-mkt__baixar-link', text: nome, attrs: { href: src, download: `${it.id}-${nome}` } }));
    }
    const confirmando = this.confirmandoPost === it.id;
    const postei = h('button', {
      class: `ui-btn ui-btn--sm${confirmando ? ' ui-btn--primary' : ''}`,
      type: 'button',
      text: confirmando ? tr('Confirmar: já postei') : tr('Já postei'),
      on: {
        click: () => {
          if (!confirmando) {
            this.confirmandoPost = it.id;
            this.redesenhar();
            return;
          }
          this.confirmandoPost = null;
          void this.decidirItens(semana, [{ id: it.id, status: 'publicado' }], 'postagem');
        },
      },
    });
    box.append(h('div', { class: 'ui-mkt__acoes' }, copiar, postei), arquivos);
    return box;
  }

  /** Prévia: slides lado a lado (clique abre o tamanho real) e vídeo com controles. */
  private previa(semana: string, id: string, a: MktArte): HTMLElement {
    const faixa = h('div', { class: 'ui-mkt__previa' });
    a.arquivos.forEach((nome, i) => {
      const src = `/api/marketing/midia/${encodeURIComponent(semana)}/${encodeURIComponent(id)}/${encodeURIComponent(nome)}?v=${a.versao}`;
      if (ehVideo(nome)) {
        faixa.append(h('video', { class: 'ui-mkt__previa-video', attrs: { src, controls: '', preload: 'metadata', playsinline: '' } }));
      } else {
        faixa.append(
          h(
            'a',
            { class: 'ui-mkt__previa-img', attrs: { href: src, target: '_blank', rel: 'noopener noreferrer', title: `${tr('Abrir')} ${i + 1}/${a.arquivos.length}` } },
            h('img', { attrs: { src, alt: `${tr('Slide')} ${i + 1}`, loading: 'lazy' } }),
          ),
        );
      }
    });
    return faixa;
  }

  /** Últimos posts por conta: barra fina do alcance (uma série só, sem legenda), números em texto ao lado. */
  private posts(contas: MktContaMetricas[]): HTMLElement {
    const sec = h('section', { class: 'ui-infra__sec' }, h('h3', { text: tr('Últimos posts') }));
    const grade = h('div', { class: 'ui-mkt__postgrid' });
    for (const c of contas) {
      const recentes = [...c.posts].sort((a, b) => b.data.localeCompare(a.data)).slice(0, POSTS_NA_TELA);
      const max = Math.max(1, ...recentes.map((p) => p.alcance ?? 0));
      const ul = h('ul', { class: 'ui-mkt__posts', attrs: { 'aria-label': `${tr('Alcance dos últimos posts de')} ${c.nome}` } });
      for (const p of recentes) ul.append(this.post(p, max));
      if (!recentes.length) ul.append(h('li', { class: 'ui-infra__vazio', text: tr('Sem posts.') }));
      grade.append(h('div', {}, h('h4', { text: c.nome }), ul));
    }
    sec.append(grade, h('p', { class: 'ui-infra__nota', text: tr('Alcance = contas únicas que viram o post. Engajamento = interações (curtidas, comentários, salvos e compartilhamentos) sobre o alcance.') }));
    return sec;
  }

  private post(p: MktPost, max: number): HTMLElement {
    const formato = p.produto === 'REELS' ? 'Reels' : p.tipo === 'CAROUSEL_ALBUM' ? 'Carrossel' : p.tipo === 'VIDEO' ? 'Vídeo' : 'Post';
    const titulo = p.legenda || formato;
    const nome = p.link ? h('a', { class: 'ui-mkt__post-nome', text: titulo, attrs: { href: p.link, target: '_blank', rel: 'noopener noreferrer' } }) : h('span', { class: 'ui-mkt__post-nome', text: titulo });
    return h(
      'li',
      { class: 'ui-mkt__post', title: `${dataPost(p.data)} · ${formato} · ${tr('alcance')} ${num(p.alcance)} · ${tr('interações')} ${num(interacoesDo(p))} · ${tr('views')} ${num(p.views)}` },
      h('span', { class: 'ui-mkt__post-k', text: `${dataPost(p.data)} · ${formato}` }),
      nome,
      h('span', { class: 'ui-mkt__barra' }, h('span', { style: `width:${((p.alcance ?? 0) / max) * 100}%` })),
      h('span', { class: 'ui-mkt__post-v', text: `${num(p.alcance)} ${tr('alcance')} · ${pct(engajamento(p))}` }),
    );
  }
}
