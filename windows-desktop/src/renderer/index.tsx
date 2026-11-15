import { createRoot } from "react-dom/client";
import { DesktopApp } from "./app.js";
import "./styles.css";
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(<DesktopApp />);
