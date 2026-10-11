// ---------------------------------------------------------------------
// markdown.js — converte um subconjunto de Markdown para o "markup" do
// Pango, que é o formato de texto formatado que o St.Label entende.
//
// Este módulo é PURO: não importa nada de gi://, então funciona (e pode ser
// testado) fora do GNOME Shell.
//
// Suportado:
//   # Título (níveis 1 a 6)      **negrito**   *itálico*   ***ambos***
//   ~~riscado~~                  `código`      [texto](url)
//   - itens, * itens, + itens    1. numerados  - [ ] / - [x] tarefas
//   > citação                    --- linha     ``` blocos de código ```
//
// Cada linha do Markdown vira uma linha na nota (quebras são preservadas).
// ---------------------------------------------------------------------

const INDENT = '\u2003';           // "espaço em": largura de um caractere M
const BULLETS = ['•', '◦', '▪'];   // marcadores por nível de aninhamento
const MAX_LEVEL = 4;

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
    const tag = /<(\/?)([a-z]+)(?:\s[^>]*)?>/g;
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
    // 1. Protege os trechos de código: nada dentro deles deve ser formatado
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, code) => {
        codes.push(code);
        return `\u0000${codes.length - 1}\u0000`;
    });

    // 2. Escapa o que sobrou (antes de criarmos as NOSSAS tags)
    s = escapeMarkup(s);

    // 3. Links: mostra só o texto, sublinhado e azul
    s = s.replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        '<span foreground="#1a5fb4"><u>$1</u></span>'
    );

    // 4. Ênfases. O (?!\s) e o (?<!\s) exigem que o marcador "cole" no texto,
    //    para que "2 * 3 * 4" não vire itálico.
    s = s.replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<b><i>$1</i></b>');
    s = s.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<b>$1</b>');
    s = s.replace(/__(?!\s)(.+?)(?<!\s)__/g, '<b>$1</b>');
    s = s.replace(/\*(?!\s)(.+?)(?<!\s)\*/g, '<i>$1</i>');
    // "_itálico_" só vale entre palavras (para não quebrar snake_case)
    s = s.replace(/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?=[^\w]|$)/g, '$1<i>$2</i>');
    s = s.replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<s>$1</s>');

    // 5. Devolve os trechos de código
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<tt>${escapeMarkup(codes[i])}</tt>`);

    // Se as ênfases se cruzaram (ex.: **a *b** c*), o markup fica inválido:
    // nesse caso mostramos a linha como texto simples em vez de perder tudo.
    return isWellFormed(s) ? s : escapeMarkup(text.replace(/\u0000/g, ''));
}

function indentOf(spaces) {
    const level = Math.min(Math.floor(spaces.length / 2), MAX_LEVEL);
    return INDENT.repeat(level);
}

export function markdownToPango(markdown) {
    const lines = markdown
        .replace(/\u0000/g, '')
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
            const size = ['x-large', 'large'][m[1].length - 1] ?? 'medium';
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
            const indent = indentOf(m[1]);
            const level = Math.min(Math.floor(m[1].length / 2), MAX_LEVEL);
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
            out.push(`${indentOf(m[1])}${m[2]}. ${inline(m[3])}`);
            continue;
        }

        // --- Texto comum
        out.push(inline(line));
    }

    return out.join('\n');
}
