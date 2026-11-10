# ESP-IDF (esp32/full images). `get_idf` puts idf.py and the toolchains on PATH for this shell. Not run for every
# shell because export.sh is slow. The sandbox venv (esptool, pyserial) is moved off PATH while IDF sets up, since
# IDF refuses to run from inside another virtual environment, and added back at the end.
export IDF_TOOLS_PATH=/opt/espressif IDF_PATH=/opt/esp-idf
# IDF also puts its own openocd-esp32 first on PATH; DeviceDock's OpenOCD (CMSIS-DAP over TCP, for shared probes) is put
# back in front, and OPENOCD_SCRIPTS (which IDF points at Espressif's scripts) is cleared so it finds its own target/ti/...
get_idf() { mkdir -p "$HOME/.cache/esp-idf-root-components"; PATH="${PATH#/opt/venv/bin:}"; . /opt/esp-idf/export.sh; PATH="/opt/openocd/bin:$PATH:/opt/venv/bin"; unset OPENOCD_SCRIPTS; }
