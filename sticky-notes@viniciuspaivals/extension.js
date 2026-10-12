import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {StickyNote, createNoteData, noteLayer} from './stickyNote.js';

const DATA_FILE_NAME = 'sticky-notes.json';

//TAMANHO (EM PX) DO ICONE NO PAINEL (O PADRAO DO SHELL É 16)
const PANEL_ICON_SIZE = 20;

//ESPERA ANTES DE GRAVAR NO DISCO
const SAVE_DELAY_MS = 500;

//NOVAS NOTAS APARECEM EM CASCATA
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

        //SE OS MONITORES MUDAREM (RESOLUÇÃO, MONITOR, CONECTADO/DESCONECTADO), TRAZ AS NOTAS DE VOLTA PARA A TELA
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._notes.forEach(note => note.ensureOnScreen());
            this._queueSave();
        });

        this._loadNotes();
    }

    disable() {
        //GRAVA O QUE AINDA ESTIVER PENDENTE ANTES DE DESTRUIR AS NOTAS
        this._flushPendingSave();


        //SINAL DE UM OBEJTO QUE NÃO É NOSSO: PRECISA SER DESCONECTADO
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._notes.forEach(note => note.destroy());
        this._notes = [];

        this._minimizeItem = null;
        this._indicator?.destroy();
        this._indicator = null;

        this._theme?.get_theme().unload_stylesheet(this._stylesheet);
        this._theme = null;
        this._stylesheet = null;

        this._dataFile = null;
    }

    //INTERFACE DO PAINEL ---#
    _loadStylesheet() {
        this._theme = St.ThemeContext.get_for_stage(global.stage);
        this._stylesheet = this.dir.get_child('stylesheet.css');
        this._theme.get_theme().load_stylesheet(this._stylesheet);
    }

    _createIndicator() { //FUNÇÃO RESPONSÁVEL PELO BOTÃO DO PAINEL
        //CRIA O BOTÃO
        this._indicator = new PanelMenu.Button(0.0, 'Sticky Notes', false);
        this._indicator._clickGesture.set_enabled(false);

        //ADICIONA ÍCONE ESPECÍFICO AO BOTÃO
        this._indicator.add_child(new St.Icon({
            icon_name: 'accessories-text-editor-symbolic',
            style_class: 'system-status-icon',
            icon_size: PANEL_ICON_SIZE,
        }));

        //CAPTURA OS EVENTOS (BOTÃO PRESSIONADO)
        this._indicator.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            const isSecondary = button === Clutter.BUTTON_SECONDARY || button === 3;

            //BOTÃO DIREITO DO MOUSE ABRE O MENU E EXIBE AS OPÇÕES DISPONÍVEIS
            if (isSecondary) {
                this._updateMenuState();
                this._indicator.menu?.toggle();
            }
            return Clutter.EVENT_STOP;
        });

        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _buildMenu() { //FUNÇÃO QUE CONSTROI O MENU DE OPÇÕES
        //CRIA O ITEM 'Criar nota', CHAMANDO A FUNÇÃO _createNote() CASO SEJA ATIVO
        const createItem = new PopupMenu.PopupImageMenuItem('Criar nota', 'list-add-symbolic');
        createItem.connect('activate', () => {
            this._createNote();
        });
        this._indicator.menu.addMenuItem(createItem);

        //CRIA O ITEM MINIMIZAR NOTAS, CHAMANDO A FUNÇÃO _toggleMinimizeAll CASO SEJA ATIVO
        this._minimizeItem = new PopupMenu.PopupImageMenuItem('Minimizar notas', 'window-minimize-symbolic');
        this._minimizeItem.connect('activate', () => {
            this._toggleMinimizeAll();
        });
        this._indicator.menu.addMenuItem(this._minimizeItem);

        this._indicator.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._updateMenuState();
        });
    }

    _updateMenuState() { //FUNÇÃO QUE ATUALIZA O ESTADO DO BOTÃO DO PAINEL
        if (!this._minimizeItem)
            return;

        const hasNotes = this._notes.length > 0;
        this._minimizeItem.setSensitive(hasNotes);

        const anyExpanded = this._notes.some(note => !note.isMinimized);
        if (!hasNotes || anyExpanded) {
            this._minimizeItem.label.text = 'Minimizar notas';
            this._minimizeItem.setIcon('window-minimize-symbolic');
        } else {
            this._minimizeItem.label.text = 'Restaurar notas';
            this._minimizeItem.setIcon('window-restore-symbolic');
        }
    }

    _toggleMinimizeAll() { //FUNÇÃO QUE MINIMIZA TODAS AS NOTAS
        //VERIFICA SE POSSUI NOTAS EXPANDIDAS
        const anyExpanded = this._notes.some(note => !note.isMinimized);
        const targetState = anyExpanded;
        //PERCORRE AS NOTAS E MINIMIZA TODAS
        for (const note of this._notes)
            note.setMinimized(targetState);
        this._queueSave();
    }

    //NOTAS ---#
    _createNote(data = {}, { persist = true } = {}) { //FUNÇÃO QUE CRIA NOTAS
        //OFFSET RESPONSÁVEL PELO EFEITO CASCATA DAS NOTAS
        const offset = CASCADE_START + (this._notes.length % CASCADE_LENGTH) * CASCADE_STEP;
        const noteData = createNoteData(data, offset, offset);

        //CRIA A NOVA NOTA
        const note = new StickyNote(noteData);
        //EXCLUI A NOTA
        note.connect('close-requested', () => this._removeNote(note));
        //SE A NOTA FOR MODFICADA É SALVA
        note.connect('note-changed', () => this._queueSave());

        noteLayer().add_child(note);
        //SETA A POSIÇÃO DA NOTA NO MONITOR
        note.set_position(noteData.x, noteData.y);
        note.ensureOnScreen();   //GARANTE QUE A NOTA ESTEJA VISÍVEL

        //ENVIA A NOTA AO ARRAY
        this._notes.push(note);

        if (persist)
            this._saveNow();
    }

    _removeNote(note) { //FUNÇÃO QUE REMOVE (APAGA) AS NOTAS
        this._notes = this._notes.filter(n => n !== note);
        note.destroy();
        this._saveNow();
    }

    //PERSISTÊNCIA ---#
    //PARA EDIÇÕES FREQUENTES (DIGITAR, MOVER): JUNTA VÁRIAS EM UMA SÓ GRAVAÇÃO
    _queueSave() {
        if (this._saveTimeoutId) //NOTA JÁ ESTÁ MARCADA PARA SER SALVA
            return;

        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveTimeoutId = 0;
            this._saveNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushPendingSave() { 
        if (this._saveTimeoutId) //CASO A NOTA ESTEJA MARCADA, ESTA É SALVA AUTOMATICAMENTE
            this._saveNow();
    }

    _saveNow() { //FUNÇÃO QUE GRAVA IMEDIATAMENTE (E CANCELA QUALQUER GRAVAÇÃO AGENDADA)
        if (this._saveTimeoutId) { //CASO ESTEJA MARCADA PARA SER SALVA, REMOVE A MARCAÇÃO
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }

        const json = JSON.stringify(this._notes.map(note => note.noteData));
        if (json === this._lastSavedJson)
            return;  //NENHUMA ALTERAÇÃO DESDE A ÚLTIMA GRAVAÇÃO

        try { //TENTA SALVAR OS CONTEÚDOS DAS NOTAS
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

        //SÓ GRAVA SE A VALIDAÇÃO DOS DADOS ALTEROU ALGO (EX: NOTA FORA DA TELA)
        this._saveNow();
    }

    _readSavedNotes() { //FUNÇÃO QUE LÊ O ARQUIVO DE NOTAS. DEVOLVE [] (ARRAY VAZIO) SE ELE AINDA NÃO EXISTE OU NÃO PUDER SER LIDO.
        if (!this._dataFile.query_exists(null))
            return [];   //PRIMEIRA EXEC

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

    //EVITA QUE A PRÓXIMA GRAVAÇÃO SOBREESCREVA UM ARQUIVO CORROMPIDO, PARA QUE ESTE NÃO SEJA PERDIDO
    _backupUnreadableFile() {
        try {
            const backup = Gio.File.new_for_path(`${this._dataFile.get_path()}.bak`);
            this._dataFile.copy(backup, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (e) {
            logError(e, 'Sticky Notes: falha ao guardar cópia do arquivo ilegível');
        }
    }
}
