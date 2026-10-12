import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {markdownToPango} from './markdown.js';

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 200;
const MIN_WIDTH = 180;
const MIN_HEIGHT = 100;

const COLORS = ['yellow', 'pink', 'blue', 'green'];
const DEFAULT_COLOR = 'yellow';

const ICON_PREVIEW = 'view-reveal-symbolic';     // mostrado no modo EDITAR
const ICON_EDIT = 'document-edit-symbolic';      // mostrado no modo VISUALIZAR
const EMPTY_PREVIEW_MARKUP =
    '<span foreground="#8a8a8a"><i>(nota vazia — dê dois cliques para editar)</i></span>';

// Limita um valor ao intervalo [min, max] e arredonda para pixel inteiro.
// Se o intervalo for inválido (max < min), prevalece o mínimo.
function clampInt(value, min, max) {
    return Math.round(Math.max(min, Math.min(value, max)));
}

function toInt(value, fallback) {
    return Number.isFinite(value) ? Math.round(value) : fallback;
}

function enableWrapping(clutterText) {
    clutterText.set_line_wrap(true);
    clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);  // quebra até palavras longas
    clutterText.set_ellipsize(Pango.EllipsizeMode.NONE);
}

// Camada onde as notas vivem: a do papel de parede, abaixo de TODAS as janelas.
// "_backgroundGroup" é API privada do Shell; concentrar o acesso aqui facilita
// o ajuste caso uma versão futura do GNOME a renomeie.
export function noteLayer() {
    return Main.layoutManager._backgroundGroup;
}

// Valida e completa os dados de uma nota (vindos do arquivo ou de uma nota nova).
// Valores ausentes ou inválidos viram os padrões.
export function createNoteData(data = {}, fallbackX = 100, fallbackY = 100) {
    return {
        text: typeof data.text === 'string' ? data.text : '',
        x: toInt(data.x, fallbackX),
        y: toInt(data.y, fallbackY),
        width: toInt(data.width, DEFAULT_WIDTH),
        height: toInt(data.height, DEFAULT_HEIGHT),
        color: COLORS.includes(data.color) ? data.color : DEFAULT_COLOR,
        preview: data.preview === true,
        minimized: data.minimized === true,
    };
}

// ---------------------------------------------------------------------
// StickyNote: o widget de UMA nota.
//
// Recebe um objeto "noteData" (veja createNoteData), que é a fonte única da
// verdade: a nota o atualiza e emite 'note-changed'. Quem decide salvar em
// disco é a extensão.
// ---------------------------------------------------------------------
export const StickyNote = GObject.registerClass({
    Signals: {
        'close-requested': {},
        'note-changed': {},
    },
}, class StickyNote extends St.BoxLayout {
    _init(noteData) {
        super._init({
            vertical: true,
            reactive: true,
        });

        this.noteData = noteData;
        this._color = noteData.color;
        this._previewMode = false;
        this._minimized = false;

        this._applyColor();
        this.set_size(noteData.width, noteData.height);

        this._header = this._buildHeader();
        this._body = this._buildBody();
        this._footer = this._buildFooter();

        this.add_child(this._header);
        this.add_child(this._body);
        this.add_child(this._footer);

        // Notas salvas em modo de visualização reabrem formatadas
        this._setPreviewMode(noteData.preview, false);

        if (noteData.minimized)
            this.setMinimized(true, false);
    }

    // --- Construção da interface -----------------------------------------

    // Título (alça para mover) + paleta de cores + botão de modo + fechar
    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'sticky-note-header',
            x_expand: true,
        });

        const title = new St.Label({
            text: 'Nota',
            style_class: 'sticky-note-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        title.connect('button-press-event', (_actor, event) => {
            if (event.get_click_count?.() === 2) {
                this.setMinimized(!this._minimized);
                return Clutter.EVENT_STOP;
            }
            return this._beginMove(event);
        });

        const palette = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        for (const name of COLORS) {
            const dot = new St.Button({
                style_class: `sticky-note-dot sticky-note-dot-${name}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            dot.connect('clicked', () => this._setColor(name));
            palette.add_child(dot);
        }

        // Alterna entre EDITAR (Markdown puro) e VISUALIZAR (formatado)
        this._modeIcon = new St.Icon({ style_class: 'sticky-note-mode-icon' });
        this._modeButton = new St.Button({
            style_class: 'sticky-note-mode',
            y_align: Clutter.ActorAlign.CENTER,
            child: this._modeIcon,
        });
        this._modeButton.connect('clicked', () => this._setPreviewMode(!this._previewMode));

        const closeButton = new St.Button({
            style_class: 'sticky-note-close',
            label: '✕',
        });
        closeButton.connect('clicked', () => this.emit('close-requested'));

        for (const child of [title, palette, this._modeButton, closeButton])
            header.add_child(child);

        return header;
    }

    // Área rolável com o campo de edição e o texto formatado (um por vez)
    _buildBody() {
        this._entry = this._buildEntry();
        this._previewLabel = this._buildPreviewLabel();

        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._content.add_child(this._entry);
        this._content.add_child(this._previewLabel);

        const scroll = new St.ScrollView({
            style_class: 'sticky-note-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            reactive: true,
        });
        scroll.add_child(this._content);

        scroll.connect('button-press-event', (_actor, event) => {
            if (this._previewMode) {
                // Duplo clique no texto formatado volta para a edição.
                // (O "?." evita erro caso o método não exista nesta versão.)
                if (event.get_click_count?.() === 2)
                    this._setPreviewMode(false);
                return Clutter.EVENT_PROPAGATE;
            }

            // Clicar na área vazia da nota também foca o campo de texto
            this._entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });

        this._scroll = scroll;
        return scroll;
    }

    _buildEntry() {
        const entry = new St.Entry({
            style_class: 'sticky-note-text',
            can_focus: true,
            x_expand: true,
            y_expand: true,
        });

        // Definido ANTES de conectar os sinais, para não disparar 'text-changed'
        entry.set_text(this.noteData.text);

        // St.Entry é de uma linha por padrão; estes ajustes o tornam multi-linha
        const ct = entry.clutter_text;
        ct.set_single_line_mode(false);
        ct.set_activatable(false);       // Enter insere nova linha em vez de "confirmar"
        enableWrapping(ct);

        entry.connect('button-press-event', () => {
            entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });

        ct.connect('text-changed', () => this._update({ text: entry.get_text() }));
        ct.connect('cursor-changed', () => this._scrollToCursor());

        return entry;
    }

    // O campo de edição não mostra formatação enquanto você digita, então o
    // texto formatado é exibido num St.Label à parte
    _buildPreviewLabel() {
        const label = new St.Label({
            style_class: 'sticky-note-preview',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        enableWrapping(label.clutter_text);
        return label;
    }

    // Alça de redimensionamento no canto inferior direito
    _buildFooter() {
        const footer = new St.BoxLayout({ x_expand: true });

        const grip = new St.Label({
            text: '◢',
            style_class: 'sticky-note-resize',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            reactive: true,
        });
        grip.connect('button-press-event', (_actor, event) => this._beginResize(event));

        footer.add_child(grip);
        return footer;
    }

    // --- Estado ----------------------------------------------------------

    // Atualiza os dados da nota e avisa a extensão para salvar
    _update(changes) {
        Object.assign(this.noteData, changes);
        this.emit('note-changed');
    }

    _applyColor() {
        this.style_class = `sticky-note sticky-note-${this._color}`;
    }

    _setColor(name) {
        if (name === this._color)
            return;

        this._color = name;
        this._applyColor();
        this._update({ color: name });
    }

    _setPreviewMode(enabled, notify = true) {
        this._previewMode = enabled;

        if (enabled) {
            const text = this._entry.get_text();
            const markup = text.trim() === '' ? EMPTY_PREVIEW_MARKUP : markdownToPango(text);
            this._previewLabel.clutter_text.set_markup(markup);
        }

        this._entry.visible = !enabled;
        this._previewLabel.visible = enabled;
        this._modeIcon.icon_name = enabled ? ICON_EDIT : ICON_PREVIEW;

        if (notify) {
            this._update({ preview: enabled });
            if (!enabled)
                this._entry.grab_key_focus();
        }
    }

    get isMinimized() {
        return this._minimized;
    }

    setMinimized(minimized, notify = true) {
        if (this._minimized === minimized)
            return;

        this._minimized = minimized;

        if (minimized) {
            this.add_style_class_name('sticky-note-minimized');
            this._body.visible = false;
            this._footer.visible = false;
            if (this._modeButton)
                this._modeButton.visible = false;
            this.height = -1;
        } else {
            this.remove_style_class_name('sticky-note-minimized');
            this._body.visible = true;
            this._footer.visible = true;
            if (this._modeButton)
                this._modeButton.visible = true;
            this.set_size(this.noteData.width, this.noteData.height);
            this.ensureOnScreen();
        }

        if (notify)
            this._update({ minimized });
    }

    // --- Limites da tela -------------------------------------------------

    // Devolve a área útil (sem painel/dock) do monitor que contém o ponto (x, y)
    _workAreaAt(x, y) {
        const lm = Main.layoutManager;
        const monitor = lm.monitors.find(m =>
            x >= m.x && x < m.x + m.width &&
            y >= m.y && y < m.y + m.height
        ) ?? lm.primaryMonitor;

        return monitor ? lm.getWorkAreaForMonitor(monitor.index) : null;
    }

    // Mantém a nota inteira dentro da área (se houver uma)
    _constrainPosition(x, y, area) {
        if (!area)
            return [Math.round(x), Math.round(y)];

        return [
            clampInt(x, area.x, area.x + area.width - this.width),
            clampInt(y, area.y, area.y + area.height - this.height),
        ];
    }

    // Chamado ao carregar a nota e quando os monitores mudam: ajusta o tamanho
    // aos limites e puxa a nota de volta se estiver fora da tela.
    // Não emite 'note-changed': quem chama decide quando salvar.
    ensureOnScreen() {
        const area = this._workAreaAt(
            this.x + this.width / 2,
            this.y + this.height / 2
        );
        if (!area)
            return;

        const width = clampInt(this.width, MIN_WIDTH, area.width);
        const curHeight = this._minimized ? this.height : this.noteData.height;
        const height = clampInt(curHeight, this._minimized ? 0 : MIN_HEIGHT, area.height);
        const x = clampInt(this.x, area.x, area.x + area.width - width);
        const y = clampInt(this.y, area.y, area.y + area.height - height);

        if (!this._minimized)
            this.set_size(width, height);
        else
            this.set_position(x, y);

        Object.assign(this.noteData, {
            x,
            y,
            width,
            height: this._minimized ? this.noteData.height : height,
        });
    }

    // --- Rolagem que acompanha o cursor ----------------------------------

    // Agenda o cálculo para quando o layout terminar (idle); se já houver um
    // agendado, não cria outro
    _scrollToCursor() {
        if (this._scrollIdleId || this._previewMode)
            return;

        this._scrollIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollIdleId = 0;
            this._ensureCursorVisible();
            return GLib.SOURCE_REMOVE;
        });
    }

    _ensureCursorVisible() {
        try {
            // O nome da propriedade varia entre versões do St: tentamos os dois
            const adj = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
            if (!adj)
                return;

            const ct = this._entry.clutter_text;
            const rect = ct.get_cursor_rect();
            const [, ctY] = ct.get_transformed_position();
            const [, contentY] = this._content.get_transformed_position();

            // Posição do cursor relativa ao topo do conteúdo rolável
            const top = ctY + rect.origin.y - contentY;
            const bottom = top + rect.size.height;

            if (top < adj.value)
                adj.value = top;
            else if (bottom > adj.value + adj.page_size)
                adj.value = bottom - adj.page_size;
        } catch (e) {
            logError(e, 'Sticky Notes: falha ao rolar até o cursor');
        }
    }

    // --- Mover e redimensionar -------------------------------------------

    _beginMove(event) {
        const origX = this.x;
        const origY = this.y;

        this._trackPointer(
            event,
            (dx, dy, pointerX, pointerY) => {
                // A área vale para o monitor onde está o ponteiro
                const area = this._workAreaAt(pointerX, pointerY);
                this.set_position(...this._constrainPosition(origX + dx, origY + dy, area));
            },
            () => this._update({ x: this.x, y: this.y })
        );
        return Clutter.EVENT_STOP;
    }

    _beginResize(event) {
        const origW = this.width;
        const origH = this.height;

        // A área é definida uma vez, no início, para não "pular" de monitor
        const area = this._workAreaAt(this.x + origW / 2, this.y + origH / 2);

        this._trackPointer(
            event,
            (dx, dy) => {
                // A borda direita/inferior não pode passar do limite da área
                const maxWidth = area ? area.x + area.width - this.x : Infinity;
                const maxHeight = area ? area.y + area.height - this.y : Infinity;

                this.set_size(
                    clampInt(origW + dx, MIN_WIDTH, maxWidth),
                    clampInt(origH + dy, MIN_HEIGHT, maxHeight)
                );
            },
            () => this._update({ width: this.width, height: this.height })
        );
        return Clutter.EVENT_STOP;
    }

    // Acompanha o ponteiro no stage inteiro, mas SÓ enquanto o botão está
    // pressionado. onMove recebe o deslocamento (dx, dy) desde o clique e a
    // posição atual do ponteiro (x, y); onEnd é chamado ao soltar.
    _trackPointer(startEvent, onMove, onEnd) {
        this._stopTracking();

        const [startX, startY] = startEvent.get_coords();

        this._motionId = global.stage.connect('motion-event', (_actor, ev) => {
            const [x, y] = ev.get_coords();
            onMove(x - startX, y - startY, x, y);
            return Clutter.EVENT_STOP;
        });

        this._releaseId = global.stage.connect('button-release-event', () => {
            this._stopTracking();
            onEnd();
            return Clutter.EVENT_STOP;
        });
    }

    _stopTracking() {
        if (this._motionId) {
            global.stage.disconnect(this._motionId);
            this._motionId = 0;
        }
        if (this._releaseId) {
            global.stage.disconnect(this._releaseId);
            this._releaseId = 0;
        }
    }

    // Sinais no global.stage e fontes do GLib NÃO são limpos pelo GNOME ao
    // destruir a nota: precisamos desfazê-los aqui.
    destroy() {
        this._stopTracking();

        if (this._scrollIdleId) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = 0;
        }

        super.destroy();
    }
});
