import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {StickyNote, createNoteData, noteLayer} from './stickyNote.js';

const DATA_FILE_NAME = 'sticky-notes.json';

// Tamanho (em px) do ícone no painel superior. O padrão do Shell é 16.
const PANEL_ICON_SIZE = 24;

// Espera antes de gravar no disco: digitar uma frase gera uma gravação só,
// em vez de uma por tecla.
const SAVE_DELAY_MS = 500;

// Notas novas aparecem em cascata, em vez de empilhadas no mesmo ponto
const CASCADE_START = 100;
const CASCADE_STEP = 24;
const CASCADE_LENGTH = 10;

export default class StickyNotesExtension extends Extension {
    enable() {
        this._notes = [];
        this._saveTimeoutId = 0;
        this._lastSavedJson = null;

        this._dataFile = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), DATA_FILE_NAME])
        );

        this._loadStylesheet();
        this._createIndicator();

        // Se os monitores mudarem (resolução, monitor conectado/desconectado),
        // traz as notas de volta para a tela
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._notes.forEach(note => note.ensureOnScreen());
            this._queueSave();
        });

        this._loadNotes();
    }

    disable() {
        // Grava o que ainda estiver pendente ANTES de destruir as notas
        this._flushPendingSave();

        // Sinal de um objeto que NÃO é nosso: precisa ser desconectado
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._notes.forEach(note => note.destroy());
        this._notes = [];

        this._indicator?.destroy();
        this._indicator = null;

        this._theme?.get_theme().unload_stylesheet(this._stylesheet);
        this._theme = null;
        this._stylesheet = null;

        this._dataFile = null;
    }

    // --- Interface do painel ---------------------------------------------

    _loadStylesheet() {
        this._theme = St.ThemeContext.get_for_stage(global.stage);
        this._stylesheet = this.dir.get_child('stylesheet.css');
        this._theme.get_theme().load_stylesheet(this._stylesheet);
    }

    // Botão no painel superior; o clique cria uma nota
    _createIndicator() {
        // O terceiro argumento (true) desativa o menu padrão, que consumiria o clique
        this._indicator = new PanelMenu.Button(0.0, 'Sticky Notes', true);
        this._indicator.add_child(new St.Icon({
            icon_name: 'accessories-text-editor-symbolic',
            style_class: 'system-status-icon',
            icon_size: PANEL_ICON_SIZE,
        }));
        this._indicator.connect('button-press-event', () => {
            this._createNote();
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    // --- Notas -----------------------------------------------------------

    // persist = false é usado ao carregar: as notas já vieram do arquivo
    _createNote(data = {}, { persist = true } = {}) {
        const offset = CASCADE_START + (this._notes.length % CASCADE_LENGTH) * CASCADE_STEP;
        const noteData = createNoteData(data, offset, offset);

        const note = new StickyNote(noteData);
        note.connect('close-requested', () => this._removeNote(note));
        note.connect('note-changed', () => this._queueSave());

        noteLayer().add_child(note);
        note.set_position(noteData.x, noteData.y);
        note.ensureOnScreen();   // garante que a nota (nova ou carregada) esteja visível

        this._notes.push(note);

        if (persist)
            this._saveNow();
    }

    _removeNote(note) {
        this._notes = this._notes.filter(n => n !== note);
        note.destroy();
        this._saveNow();
    }

    // --- Persistência ----------------------------------------------------

    // Para edições frequentes (digitar, mover): junta várias em uma só gravação
    _queueSave() {
        if (this._saveTimeoutId)
            return;

        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveTimeoutId = 0;
            this._saveNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushPendingSave() {
        if (this._saveTimeoutId)
            this._saveNow();
    }

    // Grava imediatamente (e cancela qualquer gravação agendada)
    _saveNow() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }

        const json = JSON.stringify(this._notes.map(note => note.noteData));
        if (json === this._lastSavedJson)
            return;   // nada mudou desde a última gravação

        try {
            this._dataFile.replace_contents(
                json,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            this._lastSavedJson = json;
        } catch (e) {
            logError(e, 'Sticky Notes: falha ao salvar');
        }
    }

    _loadNotes() {
        for (const data of this._readSavedNotes())
            this._createNote(data, { persist: false });

        // Só grava se a validação dos dados alterou algo (ex.: nota fora da tela)
        this._saveNow();
    }

    // Lê o arquivo de notas. Devolve [] se ele ainda não existe ou não puder ser lido.
    _readSavedNotes() {
        if (!this._dataFile.query_exists(null))
            return [];   // primeira execução

        try {
            const [, contents] = this._dataFile.load_contents(null);
            const json = new TextDecoder().decode(contents);
            const data = JSON.parse(json);

            if (!Array.isArray(data))
                throw new Error('esperava uma lista de notas');

            this._lastSavedJson = json;
            return data;
        } catch (e) {
            logError(e, 'Sticky Notes: arquivo de notas ilegível');
            this._backupUnreadableFile();
            return [];
        }
    }

    // Sem isto, a próxima gravação sobrescreveria um arquivo corrompido,
    // perdendo qualquer chance de recuperá-lo
    _backupUnreadableFile() {
        try {
            const backup = Gio.File.new_for_path(`${this._dataFile.get_path()}.bak`);
            this._dataFile.copy(backup, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (e) {
            logError(e, 'Sticky Notes: falha ao guardar cópia do arquivo ilegível');
        }
    }
}
