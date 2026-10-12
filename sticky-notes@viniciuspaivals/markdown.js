/*
markdown.js - CONVERTE UM SUBCONJUTNO DE MARKDOWN PARA O "markup"
Pango, QUE É O FORMATO DE TEXTO FORMATADO QUE O St.Label UTILIZA.

SUPORTADO:
  # Título (níveis 1 a 6)      **negrito**   *itálico*   ***ambos***
  ~~riscado~~                  `código`      [texto](url)
  - itens, * itens, + itens    1. numerados  - [ ] / - [x] tarefas
  > citação                    --- linha     ``` blocos de código ```
//CADA LINHA DO MARKDOWN VIRA UMA LINHA NA NOTA (QUEBRAS SÃO PRESERVADAS)
*/

const INDENT = '\u2003';              //"ESPAÇO EM": LARGURA DE UM CARACTERE M
const BULLETS = ['•', '◦', '▪'];      //MARCADORES POR NÍVEL DE ANINHAMENTO
const MAX_LEVEL = 4;
const HEADING_SIZES = ['x-large', 'large'];  //NÍVEIS 3+ USAM 'MEDIUM'

/* 
MARCADOR TEMPORÁRIO USADO PARA PROTEGER TRECHOS DE CÓDIGO. É REMOVIDO DO 
TEXTO DE ENTADA ANTES DO USO, ENTÃO NUNCA COLIDE COM CONTEÚDO DO USUÁRIO
*/
const SLOT = '\u0000';
const SLOT_PATTERN = new RegExp(`${SLOT}(\\d+)${SLOT}`, 'g');

// Ênfases, aplicadas NESTA ordem. O (?!\s) e o (?<!\s) exigem que o
// marcador "cole" no texto, para que "2 * 3 * 4" não vire itálico.
// "_itálico_" só vale entre palavras, para não quebrar snake_case.
const EMPHASIS_RULES = [
    [/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<b><i>$1</i></b>'],
    [/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<b>$1</b>'],
    [/__(?!\s)(.+?)(?<!\s)__/g, '<b>$1</b>'],
    [/\*(?!\s)(.+?)(?<!\s)\*/g, '<i>$1</i>'],
    [/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?=[^\w]|$)/g, '$1<i>$2</i>'],
    [/~~(?!\s)(.+?)(?<!\s)~~/g, '<s>$1</s>'],
];

// No Pango, <, > e & têm significado especial e PRECISAM ser escapados.
export function escapeMarkup(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Confere se as tags abrem e fecham na ordem certa. Markup inválido faz o
// Pango recusar o texto inteiro, então preferimos cair para texto simples.
function isWellFormed(markup) {
    const stack = [];
    const tag = /<(\/?)([a-z]+)(?:\s[^>]*)?>/g;   // local: 'g' guarda estado
    let match;

    while ((match = tag.exec(markup)) !== null) {
        if (match[1]) {
            if (stack.pop() !== match[2])
                return false;
        } else {
            stack.push(match[2]);
        }
    }
    return stack.length === 0;
}

// Formatação DENTRO de uma linha: negrito, itálico, código, links...
function inline(text) {
    const source = text.replaceAll(SLOT, '');

    // 1. Protege os trechos de código: nada dentro deles deve ser formatado
    const codes = [];
    let s = source.replace(/`([^`]+)`/g, (_, code) => {
        codes.push(code);
        return `${SLOT}${codes.length - 1}${SLOT}`;
    });

    // 2. Escapa o que sobrou (antes de criarmos as NOSSAS tags)
    s = escapeMarkup(s);

    // 3. Links: mostra só o texto, sublinhado e azul
    s = s.replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        '<span foreground="#1a5fb4"><u>$1</u></span>'
    );

    // 4. Ênfases
    for (const [pattern, replacement] of EMPHASIS_RULES)
        s = s.replace(pattern, replacement);

    // 5. Devolve os trechos de código
    s = s.replace(SLOT_PATTERN, (_, i) => `<tt>${escapeMarkup(codes[i])}</tt>`);

    // Se as ênfases se cruzaram (ex.: **a *b** c*), o markup fica inválido:
    // nesse caso mostramos a linha como texto simples em vez de perder tudo.
    return isWellFormed(s) ? s : escapeMarkup(source);
}

// Nível de aninhamento de uma lista: 2 espaços = 1 nível
function levelOf(spaces) {
    return Math.min(Math.floor(spaces.length / 2), MAX_LEVEL);
}

export function markdownToPango(markdown) {
    const lines = markdown
        .replaceAll(SLOT, '')
        .replace(/\r\n?/g, '\n')
        .split('\n');

    const out = [];
    let inFence = false;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\t/g, '    ');
        let m;

        // --- Bloco de código (```): tudo dentro vai literal, em monoespaçada
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            out.push(`<tt>${escapeMarkup(line)}</tt>`);
            continue;
        }

        // --- Títulos
        if ((m = line.match(/^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/))) {
            const size = HEADING_SIZES[m[1].length - 1] ?? 'medium';
            out.push(`<span size="${size}" weight="bold">${inline(m[2])}</span>`);
            continue;
        }

        // --- Linha horizontal
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
            out.push('<span foreground="#8a8a8a">──────────────</span>');
            continue;
        }

        // --- Citação
        if ((m = line.match(/^\s*>\s?(.*)$/))) {
            out.push(`<span foreground="#5e5e5e">▎ <i>${inline(m[1])}</i></span>`);
            continue;
        }

        // --- Lista (com marcadores ou tarefas)
        if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
            const level = levelOf(m[1]);
            const indent = INDENT.repeat(level);
            const task = m[2].match(/^\[( |x|X)\]\s+(.*)$/);

            if (task) {
                const done = task[1] !== ' ';
                out.push(done
                    ? `${indent}☑ <span foreground="#6b6b6b"><s>${inline(task[2])}</s></span>`
                    : `${indent}☐ ${inline(task[2])}`);
            } else {
                out.push(`${indent}${BULLETS[level % BULLETS.length]} ${inline(m[2])}`);
            }
            continue;
        }

        // --- Lista numerada
        if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
            out.push(`${INDENT.repeat(levelOf(m[1]))}${m[2]}. ${inline(m[3])}`);
            continue;
        }

        // --- Texto comum
        out.push(inline(line));
    }

    return out.join('\n');
}
