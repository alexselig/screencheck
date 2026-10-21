import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { migrateLegacyStorage } from "./storage-migration";
import "./fonts.css";
import "./bauhausian-tokens.css";
import "./styles.css";

try {
  migrateLegacyStorage();
} catch {
  // Storage can be unavailable (private mode); the app works without it.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
