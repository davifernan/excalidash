import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./integrations/excalidraw/styles";
import "./index.css";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { configureDisplayFont } from "./utils/displayFont";
import { startErrorTracking } from "./errorTracker";

configureDisplayFont();
startErrorTracking();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
