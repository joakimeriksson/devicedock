# ESP-IDF (esp32/full images). `get_idf` puts idf.py and the toolchains on PATH for this shell. Not run for every
# shell because export.sh is slow. The sandbox venv (esptool, pyserial) is moved off PATH while IDF sets up, since
# IDF refuses to run from inside another virtual environment, and added back at the end.
export IDF_TOOLS_PATH=/opt/espressif IDF_PATH=/opt/esp-idf
# IDF also puts its own openocd-esp32 first on PATH; DeviceDock's OpenOCD (CMSIS-DAP over TCP, for shared probes) is put
# back in front, and OPENOCD_SCRIPTS (which IDF points at Espressif's scripts) is cleared so it finds its own target/ti/...
get_idf() { mkdir -p "$HOME/.cache/esp-idf-root-components"; PATH="${PATH#/opt/venv/bin:}"; . /opt/esp-idf/export.sh; PATH="/opt/openocd/bin:$PATH:/opt/venv/bin"; unset OPENOCD_SCRIPTS; }
# `idf.py ... flash` (flash, app-flash, erase-flash, ...) on a shared real board: idf.py runs its own esptool, so it goes
# through devicedock-flash, which asks the human once for a flash session and closes it afterwards.
# Bash only, and not in POSIX mode: a function name with a dot is not valid there, nor in sh (dash), which also reads
# profile.d. Hence the eval. Only real flash targets match (flash, app-flash, erase-flash, erase_flash, ...): an option
# a path or an option value that merely contains "flash" (-C spi_flash_demo, -B build-flash) does not.
if [ -n "$BASH_VERSION" ] && ! shopt -oq posix; then
  eval 'idf.py() {
    local a value=
    for a in "$@"; do
      if [ -n "$value" ]; then value=; continue; fi
      case "$a" in
        -C|-B|-p|-b|-D|-G|--project-dir|--build-dir|--port|--baud|--define-cache-entry|--cmake-generator) value=1 ;;
        -*|*/*) ;;
        flash|*-flash|erase_flash) devicedock-flash idf.py "$@"; return ;;
      esac
    done
    command idf.py "$@"
  }'
fi
