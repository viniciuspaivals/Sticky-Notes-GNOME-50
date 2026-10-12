#!/usr/bin/env bash
set -e

# Diretório onde o script está localizado
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Localiza o diretório de origem da extensão
if [ -d "$SCRIPT_DIR/sticky-notes@viniciuspaivals" ]; then
    SRC_DIR="$SCRIPT_DIR/sticky-notes@viniciuspaivals"
elif [ -f "$SCRIPT_DIR/metadata.json" ]; then
    SRC_DIR="$SCRIPT_DIR"
else
    # Procura metadata.json em subdiretórios caso o nome da pasta mude
    METADATA_FILE=$(find "$SCRIPT_DIR" -maxdepth 2 -name "metadata.json" -not -path "*/.*" 2>/dev/null | head -n 1)
    if [ -n "$METADATA_FILE" ]; then
        SRC_DIR="$(dirname "$METADATA_FILE")"
    else
        SRC_DIR="$SCRIPT_DIR"
    fi
fi

# Extrai o UUID do metadata.json ou usa o padrão
if [ -f "$SRC_DIR/metadata.json" ]; then
    UUID=$(grep -o '"uuid"[^,]*' "$SRC_DIR/metadata.json" | cut -d'"' -f4)
fi

UUID="${UUID:-sticky-notes@viniciuspaivals}"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "=========================================="
echo " Instalador da Extensão: Sticky Notes"
echo " UUID: ${UUID}"
echo " Origem: ${SRC_DIR}"
echo "=========================================="

echo "-> Criando diretório de instalação..."
mkdir -p "$TARGET_DIR"

echo "-> Copiando arquivos da extensão..."
if [ "$SRC_DIR" != "$SCRIPT_DIR" ]; then
    cp -rf "$SRC_DIR/"* "$TARGET_DIR/"
else
    FILES=(
        "metadata.json"
        "extension.js"
        "stickyNote.js"
        "markdown.js"
        "stylesheet.css"
    )

    for file in "${FILES[@]}"; do
        if [ -f "$SRC_DIR/$file" ]; then
            cp -f "$SRC_DIR/$file" "$TARGET_DIR/"
        fi
    done
fi

# Caso existam esquemas GSettings
if [ -d "$TARGET_DIR/schemas" ]; then
    echo "-> Compilando schemas..."
    glib-compile-schemas "$TARGET_DIR/schemas" || true
elif [ -d "$SRC_DIR/schemas" ]; then
    echo "-> Compilando schemas..."
    mkdir -p "$TARGET_DIR/schemas"
    cp -rf "$SRC_DIR/schemas/"* "$TARGET_DIR/schemas/"
    glib-compile-schemas "$TARGET_DIR/schemas" || true
fi

echo "-> Arquivos instalados em: $TARGET_DIR"

# Tenta habilitar via gnome-extensions
if command -v gnome-extensions >/dev/null 2>&1; then
    echo "-> Ativando extensão..."
    gnome-extensions enable "$UUID" 2>/dev/null || true
fi

echo ""
echo "✔ Instalação concluída com sucesso!"
echo ""
echo "Notas importantes para ativar no GNOME Shell:"
echo " - Se estiver usando Wayland: Encerre a sessão (Log out) e entre novamente."
echo " - Se estiver usando X11: Pressione Alt + F2, digite 'r' e aperte Enter."
echo " - Você também pode gerenciar a extensão pelo aplicativo 'Extensões' (gnome-extensions-app)."
echo "=========================================="
