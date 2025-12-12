import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { initSentry } from "./lib/sentry";
import { initOpenTelemetry } from "./lib/opentelemetry";

// Initialize observability before rendering
try {
  initSentry();
} catch (error) {
  console.error("[Sentry] Failed to initialize", error);
}

try {
  initOpenTelemetry();
} catch (error) {
  console.error("[OpenTelemetry] Failed to initialize", error);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
