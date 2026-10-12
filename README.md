# Sticky-Notes (GNOME 50)

Uma extensão de notas autoadesivas (sticky notes) para o GNOME Shell.

## Instalação

Para instalar a extensão localmente a partir do repositório clonado:

1. Dê permissão de execução (se necessário) e execute o script de instalação:
   ```bash
   chmod +x install.sh
   ./install.sh
   ```

2. Reinicie o GNOME Shell ou encerre a sessão para carregar a extensão:
   - **Wayland**: Encerre a sessão (Log out) e faça login novamente.
   - **X11**: Pressione `Alt + F2`, digite `r` e pressione `Enter`.

3. Se necessário, ative ou gerencie a extensão pelo aplicativo **Extensões** (`gnome-extensions-app`) ou pelo terminal:
   ```bash
   gnome-extensions enable sticky-notes@viniciuspaivals
   ```
