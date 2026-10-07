import React from "react";
import { createRoot } from "react-dom/client";
import { AgStudioAiModule, AgStudioModuleRegistry } from "ag-studio";
import App from "./App.jsx";

// Switch on Studio's agent framework. Without a model adapter (see agent.js) the agent panel simply stays unavailable.
AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

createRoot(document.getElementById("root")).render(<App />);
