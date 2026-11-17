import { registerEngine } from "../registry.js";
import { createEsp32SimEngine } from "./esp32sim.js";

// One line per supported simulator. A new engine only needs to be imported and registered here.
registerEngine("esp32sim", createEsp32SimEngine);
