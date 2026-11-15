import { initializeLocalDiagnostics } from "./diagnostics/local-debug";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

initializeLocalDiagnostics();

const root = document.getElementById("root")!;
const application = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (root.hasChildNodes()) hydrateRoot(root, application);
else createRoot(root).render(application);
