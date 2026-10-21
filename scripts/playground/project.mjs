// The playground's Tidewater registration, shared by run.mjs and the test
// that keeps docs/PLAYGROUND.md in step with the rail it describes.
import { SCREENS } from "../site/demo-app.mjs";

export const PROJECT = "tidewater";
export const PROJECT_NAME = "Tidewater";

// build-41 is the build before the agent's fixes; build-42 carries them.
export const BUILDS = ["build-41", "build-42"];

export const REGISTERED_SCREENS = SCREENS.map((screen, index) => ({
  id: screen.id,
  ordinal: index + 1,
  title: screen.title,
  group: screen.group,
  description: screen.description,
  capturePath: `${screen.id}.png`,
  viewport: { width: 1440, height: 1000 },
}));
