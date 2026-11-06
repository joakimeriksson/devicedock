# esptool's bootloader entry changes DTR and RTS back to back; the board's reset circuit only works if
# both reach the port in ONE operation. Check that quick consecutive changes become a single signals call.
import serial, time
s = serial.serial_for_url("rfc2217://127.0.0.1:2217", baudrate=115200, timeout=2)
time.sleep(0.3)
print("MARK-BEGIN", flush=True)
s.dtr = False; s.rts = True            # chip in reset, IO0 high
time.sleep(0.1)
s.dtr = True; s.rts = False            # IO0 low and EN high TOGETHER = download mode
time.sleep(0.2)
s.close()
