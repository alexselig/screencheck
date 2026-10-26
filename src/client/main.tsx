import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { OfflineBar } from "./components/offline-bar";
import { installOfflineMode, readBundle } from "./offline-api";
import { migrateLegacyStorage } from "./storage-migration";
import "./fonts.css";
import "./bauhausian-tokens.css";
import "./styles.css";

try {
  migrateLegacyStorage();
} catch {
  // Storage can be unavailable (private mode); the app works without it.
}

// Opened from a `screencheck bundle`: the bundle stands in for the server.
const bundle = readBundle();
const offline = bundle ? installOfflineMode(bundle) : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {offline ? <OfflineBar api={offline} /> : null}
    <App />
  </StrictMode>,
);
