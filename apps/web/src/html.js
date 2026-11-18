// Preact with htm: `html` tagged templates take the place of JSX, so the browser runs these files as they are.
// The vendored files are listed in ../vendor/README.md.
import { h, render } from "../vendor/preact/preact.module.js";
import htm from "../vendor/htm/htm.module.js";

export { render };
export { useEffect, useRef, useState } from "../vendor/preact/hooks.module.js";
export const html = htm.bind(h);
