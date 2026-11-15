// Readable names for USB serial ports and debug probes. WebSerial only gives the USB vendor and product id, so a board
// shows up as "Serial 10c4:ea60"; this names the USB chip or board behind the id, which is what the human recognises
// and what helps an agent pick the right tool (esptool --chip, an OpenOCD target). Names are display-only, never policy.

export type UsbId = { vendorId: number; productId: number };

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
/** "10c4:ea60": the key used to remember a board across restarts. */
export const usbKey = (u: UsbId) => `${hex4(u.vendorId)}:${hex4(u.productId)}`;

const PRODUCTS: Record<string, string> = {
  "303a:1001": "ESP32 USB-Serial/JTAG",
  "303a:0002": "ESP32-S2/S3 USB bootloader",
  "10c4:ea60": "CP210x USB-UART",
  "10c4:ea70": "CP2105 dual USB-UART",
  "10c4:ea71": "CP2108 quad USB-UART",
  "1a86:7523": "CH340 USB-UART",
  "1a86:55d3": "CH343 USB-UART",
  "1a86:55d4": "CH9102 USB-UART",
  "0403:6001": "FTDI FT232R USB-UART",
  "0403:6010": "FTDI FT2232 dual USB-UART",
  "0403:6011": "FTDI FT4232 quad USB-UART",
  "0403:6014": "FTDI FT232H USB-UART",
  "0403:6015": "FTDI FT-X USB-UART",
  "067b:2303": "Prolific PL2303 USB-UART",
  "0451:bef3": "TI XDS110 (LaunchPad)",
  "0451:bef4": "TI XDS110 (LaunchPad)",
  "2e8a:0005": "Raspberry Pi Pico (MicroPython)",
  "2e8a:000a": "Raspberry Pi Pico (USB serial)",
  "2e8a:000c": "Raspberry Pi Debug Probe",
  "0483:374b": "ST-LINK/V2-1 (Nucleo, Discovery)",
  "0483:3752": "ST-LINK/V2-1 (Nucleo, Discovery)",
  "0483:374e": "ST-LINK/V3",
  "0483:374f": "ST-LINK/V3",
  "0d28:0204": "Arm DAPLink (micro:bit, Mbed)",
  "16c0:0483": "Teensy (USB serial)",
  "1d50:6018": "Black Magic Probe",
};
const VENDORS: Record<string, string> = {
  "303a": "Espressif",
  "10c4": "Silicon Labs",
  "1a86": "WCH",
  "0403": "FTDI",
  "0451": "Texas Instruments",
  "2e8a": "Raspberry Pi",
  "0483": "STMicroelectronics",
  "1366": "SEGGER J-Link",
  "1915": "Nordic Semiconductor",
  "0d28": "Arm DAPLink",
  "2341": "Arduino",
  "2a03": "Arduino",
  "239a": "Adafruit",
  "2886": "Seeed Studio",
  "2fe3": "Zephyr",
  "1209": "Open hardware (pid.codes)",
};

/** "CP210x USB-UART (10c4:ea60)"; an unknown product of a known vendor: "Espressif USB serial (303a:4001)". */
export function usbName(vendorId?: number, productId?: number): string {
  if (vendorId === undefined || productId === undefined) return "Serial port";
  const key = usbKey({ vendorId, productId });
  const name = PRODUCTS[key] ?? (VENDORS[hex4(vendorId)] ? `${VENDORS[hex4(vendorId)]} USB serial` : "USB serial");
  return `${name} (${key})`;
}

/** Auto-share memory written before boards had readable names was keyed "Serial 10c4:ea60" (unpadded hex). */
export function migrateRememberKey(key: string): string {
  const m = /^Serial ([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(key);
  return m ? usbKey({ vendorId: parseInt(m[1], 16), productId: parseInt(m[2], 16) }) : key;
}
