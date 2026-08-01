/**
 * Showcase bootstrap.
 *
 * Initializes each section by id. Sections are independent canvases with
 * local state — no shared store is needed (each owns its own PixelEngine).
 */

import { initSandbox } from './sections/sandbox';
import { initPlanet } from './sections/planet';

const sandboxSection = document.getElementById('sandbox');
if (sandboxSection) initSandbox(sandboxSection);

const planetSection = document.getElementById('planet');
if (planetSection) initPlanet(planetSection);
