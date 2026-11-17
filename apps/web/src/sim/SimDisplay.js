import { html, useEffect, useRef, useState } from "../html.js";

/** The simulated board's screen and buttons. Engine-neutral: it only sees RGBA frames and profile hints.
 * @param {{ adapter: import("./SimAdapter.js").SimAdapter, id: string }} props */
export function SimDisplay({ adapter, id }) {
  const canvas = useRef(null);
  const [status, setStatus] = useState("");
  const [frames, setFrames] = useState(0);
  const profile = adapter.profile(id);
  const rotate = profile.display?.rotate ?? 0;

  useEffect(() => {
    const off = document.createElement("canvas");
    const offStatus = adapter.onStatus(id, (e) => setStatus(e.message));
    const offFrame = adapter.onFrame(id, (f) => {
      const c = canvas.current;
      if (!c) return;
      off.width = f.width;
      off.height = f.height;
      off.getContext("2d").putImageData(new ImageData(f.rgba, f.width, f.height), 0, 0);
      const swap = rotate === 90 || rotate === 270;
      const w = swap ? f.height : f.width, h = swap ? f.width : f.height;
      const scale = 2;
      c.width = w * scale;
      c.height = h * scale;
      const g = c.getContext("2d");
      g.imageSmoothingEnabled = false;
      g.save();
      g.translate(c.width / 2, c.height / 2);
      g.rotate((rotate * Math.PI) / 180);
      g.drawImage(off, (-f.width * scale) / 2, (-f.height * scale) / 2, f.width * scale, f.height * scale);
      g.restore();
      setFrames((n) => n + 1);
    });
    return () => {
      offStatus();
      offFrame();
    };
  }, [adapter, id, rotate]);

  return html`
    <div class="sim-display">
      <canvas
        ref=${canvas}
        width=${profile.display ? profile.display.height * 2 : 480}
        height=${profile.display ? profile.display.width * 2 : 270}
        aria-label="Simulated display"
      />
      <div class="row-actions">
        ${profile.buttons?.map(
          (b) => html`
            <button
              key=${b.pin}
              onPointerDown=${() => adapter.button(id, b.pin, true)}
              onPointerUp=${() => adapter.button(id, b.pin, false)}
              onPointerLeave=${() => adapter.button(id, b.pin, false)}
            >
              ${b.label}
            </button>
          `,
        )}
        <button onClick=${() => void adapter.reset(id)}>Reset board</button>
      </div>
      <small>${frames ? `${frames} frame(s)` : "waiting for the first frame…"}${status ? ` · ${status}` : ""}</small>
    </div>
  `;
}
