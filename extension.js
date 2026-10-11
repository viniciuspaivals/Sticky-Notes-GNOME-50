import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {markdownToPango} from './markdown.js';

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 200;
const MIN_WIDTH = 180;
const MIN_HEIGHT = 100;

// Tamanho (em px) do ícone no painel superior. O padrão do Shell é 16.
const PANEL_ICON_SIZE = 24;

const COLORS = ['yellow', 'pink', 'blue', 'green'];
const DEFAULT_COLOR = 'yellow';

// Passo 10: limita um valor ao intervalo [min, max].
// Se o intervalo for inválido (max < min), prevalece o mínimo.
function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
}

// ---------------------------------------------------------------------
// Classe StickyNote — representa UMA nota
// ---------------------------------------------------------------------
const StickyNote = GObject.registerClass({
    Signals: {
        'close-requested': {},
        'note-changed': {},
    },
}, class StickyNote extends St.BoxLayout {
    _init(noteData = {}) {
        super._init({
            vertical: true,
            reactive: true,
        });

        this.noteData = noteData;

        this._color = COLORS.includes(noteData.color) ? noteData.color : DEFAULT_COLOR;
        this._applyColor();

        this.set_size(
            noteData.width ?? DEFAULT_WIDTH,
            noteData.height ?? DEFAULT_HEIGHT
        );

        // --- Cabeçalho: título + paleta de cores + botão de fechar ---
        const header = new St.BoxLayout({
            style_class: 'sticky-note-header',
            x_expand: true,
        });

        this._title = new St.Label({
            text: 'Nota',
            style_class: 'sticky-note-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });

        const palette = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        COLORS.forEach(name => {
            const dot = new St.Button({
                style_class: `sticky-note-dot sticky-note-dot-${name}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            dot.connect('clicked', () => this._setColor(name));
            palette.add_child(dot);
        });

        // Passo 11: alterna entre EDITAR (Markdown puro) e VISUALIZAR (formatado)
        this._modeIcon = new St.Icon({ style_class: 'sticky-note-mode-icon' });
        this._modeButton = new St.Button({
            style_class: 'sticky-note-mode',
            y_align: Clutter.ActorAlign.CENTER,
            child: this._modeIcon,
        });
        this._modeButton.connect('clicked', () => this._setPreviewMode(!this._previewMode));

        this._closeButton = new St.Button({
            style_class: 'sticky-note-close',
            label: '✕',
        });
        this._closeButton.connect('clicked', () => this.emit('close-requested'));

        header.add_child(this._title);
        header.add_child(palette);
        header.add_child(this._modeButton);
        header.add_child(this._closeButton);

        // --- Campo de texto multi-linha com quebra de linha ---
        this._entry = new St.Entry({
            style_class: 'sticky-note-text',
            can_focus: true,
            x_expand: true,
            y_expand: true,
        });
        this._entry.set_text(noteData.text || '');

        const ct = this._entry.clutter_text;
        ct.set_single_line_mode(false);
        ct.set_activatable(false);
        ct.set_line_wrap(true);
        ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        ct.set_ellipsize(Pango.EllipsizeMode.NONE);

        this._entry.connect('button-press-event', () => {
            this._entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });

        ct.connect('text-changed', () => {
            this.noteData.text = this._entry.get_text();
            this.emit('note-changed');
        });

        ct.connect('cursor-changed', () => this._scrollToCursor());

        // --- Entry dentro de um container rolável ---
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._content.add_child(this._entry);

        // Passo 11: o texto formatado é mostrado num St.Label (o campo de
        // edição não consegue exibir formatação enquanto você digita)
        this._previewLabel = new St.Label({
            style_class: 'sticky-note-preview',
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        const pt = this._previewLabel.clutter_text;
        pt.set_line_wrap(true);
        pt.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        pt.set_ellipsize(Pango.EllipsizeMode.NONE);
        this._content.add_child(this._previewLabel);

        this._scroll = new St.ScrollView({
            style_class: 'sticky-note-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            reactive: true,
        });
        this._scroll.add_child(this._content);

        this._scroll.connect('button-press-event', (_actor, event) => {
            if (this._previewMode) {
                // Duplo clique no texto formatado volta para a edição.
                // (O "?." evita erro caso o método não exista nesta versão.)
                if (event.get_click_count?.() === 2)
                    this._setPreviewMode(false);
                return Clutter.EVENT_PROPAGATE;
            }

            this._entry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });

        // --- Rodapé: alça de redimensionamento ---
        const footer = new St.BoxLayout({ x_expand: true });
        const grip = new St.Label({
            text: '◢',
            style_class: 'sticky-note-resize',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            reactive: true,
        });
        footer.add_child(grip);

        this.add_child(header);
        this.add_child(this._scroll);
        this.add_child(footer);

        this._title.connect('button-press-event', (_actor, event) => this._beginMove(event));
        grip.connect('button-press-event', (_actor, event) => this._beginResize(event));

        // Passo 11: notas salvas em modo de visualização reabrem formatadas
        this._setPreviewMode(noteData.preview === true, false);
    }

    // --- Passo 11: alternar entre edição e visualização ---
    _setPreviewMode(enabled, notify = true) {
        this._previewMode = enabled;

        if (enabled) {
            const text = this._entry.get_text();
            const markup = text.trim() === ''
                ? '<span foreground="#8a8a8a"><i>(nota vazia — dê dois cliques para editar)</i></span>'
                : markdownToPango(text);
            this._previewLabel.clutter_text.set_markup(markup);
        }

        this._entry.visible = !enabled;
        this._previewLabel.visible = enabled;
        this._modeIcon.icon_name = enabled ? 'document-edit-symbolic' : 'view-reveal-symbolic';

        this.noteData.preview = enabled;

        if (notify) {
            this.emit('note-changed');
            if (!enabled)
                this._entry.grab_key_focus();
        }
    }

    // --- Passo 10: limites da tela ---

    // Devolve a área útil (sem painel/dock) do monitor que contém o ponto (x, y).
    _workAreaAt(x, y) {
        const lm = Main.layoutManager;
        const monitor = lm.monitors.find(m =>
            x >= m.x && x < m.x + m.width &&
            y >= m.y && y < m.y + m.height
        ) ?? lm.primaryMonitor;

        return monitor ? lm.getWorkAreaForMonitor(monitor.index) : null;
    }

    // Limita uma posição para que a nota inteira fique dentro da área
    _clampToArea(x, y, area) {
        return [
            Math.round(clamp(x, area.x, area.x + area.width - this.width)),
            Math.round(clamp(y, area.y, area.y + area.height - this.height)),
        ];
    }

    // Chamado ao carregar a nota e quando os monitores mudam:
    // encolhe se for maior que a tela e puxa de volta se estiver fora.
    // Não emite 'note-changed': quem chama decide quando salvar.
    ensureOnScreen() {
        const area = this._workAreaAt(
            this.x + this.width / 2,
            this.y + this.height / 2
        );
        if (!area)
            return;

        const width = Math.round(Math.min(this.width, Math.max(MIN_WIDTH, area.width)));
        const height = Math.round(Math.min(this.height, Math.max(MIN_HEIGHT, area.height)));
        const x = Math.round(clamp(this.x, area.x, area.x + area.width - width));
        const y = Math.round(clamp(this.y, area.y, area.y + area.height - height));

        this.set_size(width, height);
        this.set_position(x, y);

        Object.assign(this.noteData, { x, y, width, height });
    }

    // --- Rolar até o cursor ---
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
            const adj = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
            if (!adj)
                return;

            const ct = this._entry.clutter_text;
            const rect = ct.get_cursor_rect();
            const [, ctY] = ct.get_transformed_position();
            const [, contentY] = this._content.get_transformed_position();

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

    _applyColor() {
        this.style_class = `sticky-note sticky-note-${this._color}`;
    }

    _setColor(name) {
        if (name === this._color)
            return;
        this._color = name;
        this._applyColor();
        this.noteData.color = name;
        this.emit('note-changed');
    }

    _beginMove(event) {
        const origX = this.x;
        const origY = this.y;

        this._trackPointer(
            event,
            (dx, dy, pointerX, pointerY) => {
                let x = Math.round(origX + dx);
                let y = Math.round(origY + dy);

                // A área vale para o monitor onde está o ponteiro
                const area = this._workAreaAt(pointerX, pointerY);
                if (area)
                    [x, y] = this._clampToArea(x, y, area);

                this.set_position(x, y);
            },
            () => {
                this.noteData.x = this.x;
                this.noteData.y = this.y;
                this.emit('note-changed');
            }
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
                let width = Math.round(Math.max(MIN_WIDTH, origW + dx));
                let height = Math.round(Math.max(MIN_HEIGHT, origH + dy));

                // A borda direita/inferior não pode passar do limite da área
                if (area) {
                    width = Math.round(clamp(width, MIN_WIDTH, area.x + area.width - this.x));
                    height = Math.round(clamp(height, MIN_HEIGHT, area.y + area.height - this.y));
                }

                this.set_size(width, height);
            },
            () => {
                this.noteData.width = this.width;
                this.noteData.height = this.height;
                this.emit('note-changed');
            }
        );
        return Clutter.EVENT_STOP;
    }

    // Acompanha o ponteiro no stage inteiro, só enquanto o botão está pressionado.
    // onMove recebe: deslocamento (dx, dy) e posição atual do ponteiro (x, y).
    _trackPointer(startEvent, onMove, onEnd) {
        this._stopTracking();

        const [startX, startY] = startEvent.get_coords();

        this._motionId = global.stage.connect('motion-event', (_a, ev) => {
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

    destroy() {
        this._stopTracking();

        if (this._scrollIdleId) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = 0;
        }

        super.destroy();
    }
});

// ---------------------------------------------------------------------
// Classe principal da extensão
// ---------------------------------------------------------------------
export default class StickyNotesExtension extends Extension {
    enable() {
        this._notes = [];

        this._dataFile = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'sticky-notes.json'])
        );

        this._theme = St.ThemeContext.get_for_stage(global.stage);
        this._stylesheet = this.dir.get_child('stylesheet.css');
        this._theme.get_theme().load_stylesheet(this._stylesheet);

        this._indicator = new PanelMenu.Button(0.0, 'Sticky Notes', true);
        const icon = new St.Icon({
            icon_name: 'accessories-text-editor-symbolic',
            style_class: 'system-status-icon',
            icon_size: PANEL_ICON_SIZE,
        });
        this._indicator.add_child(icon);
        this._indicator.connect('button-press-event', () => {
            this._createNote();
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Passo 10: se os monitores mudarem (resolução, monitor
        // conectado/desconectado), traz as notas de volta para a tela
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._notes.forEach(note => note.ensureOnScreen());
            this._saveNotes();
        });

        this._loadNotes();

        console.log('Sticky Notes: extensão ativada!');
    }

    _createNote(data = {}) {
        // Passo 10: notas novas aparecem em cascata, não empilhadas
        const cascade = (this._notes.length % 10) * 24;

        const noteData = {
            text: data.text || '',
            x: Math.round(data.x ?? 100 + cascade),
            y: Math.round(data.y ?? 100 + cascade),
            width: Math.round(data.width ?? DEFAULT_WIDTH),
            height: Math.round(data.height ?? DEFAULT_HEIGHT),
            color: data.color ?? DEFAULT_COLOR,
            preview: data.preview === true,
        };

        const note = new StickyNote(noteData);
        note.connect('close-requested', () => this._removeNote(note));
        note.connect('note-changed', () => this._saveNotes());

        Main.layoutManager._backgroundGroup.add_child(note);
        note.set_position(noteData.x, noteData.y);

        // Passo 10: garante que a nota (nova ou carregada) esteja visível
        note.ensureOnScreen();

        this._notes.push(note);
        this._saveNotes();
    }

    _removeNote(note) {
        this._notes = this._notes.filter(n => n !== note);
        Main.layoutManager._backgroundGroup.remove_child(note);
        note.destroy();
        this._saveNotes();
    }

    _saveNotes() {
        const data = this._notes.map(n => n.noteData);
        try {
            this._dataFile.replace_contents(
                JSON.stringify(data),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            logError(e, 'Sticky Notes: falha ao salvar');
        }
    }

    _loadNotes() {
        try {
            const [ok, contents] = this._dataFile.load_contents(null);
            if (ok) {
                const data = JSON.parse(new TextDecoder().decode(contents));
                data.forEach(noteData => this._createNote(noteData));
            }
        } catch (e) {
            // Arquivo ainda não existe na primeira execução — normal.
        }
    }

    disable() {
        // Passo 10: sinal de um objeto que NÃO é nosso — precisa ser desconectado
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._notes.forEach(note => {
            Main.layoutManager._backgroundGroup.remove_child(note);
            note.destroy();
        });
        this._notes = [];

        this._indicator?.destroy();
        this._indicator = null;

        this._theme.get_theme().unload_stylesheet(this._stylesheet);
        this._theme = null;
        this._stylesheet = null;

        this._dataFile = null;

        console.log('Sticky Notes: extensão desativada!');
    }
}