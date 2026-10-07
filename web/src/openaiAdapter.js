// STUB. The Studio agent is switched off until this file is replaced.
//
// AG Studio is provider-agnostic: it ships no LLM connection. AG's docs provide a ready-made adapter for the OpenAI
// Responses API as part of their "Direct LLM Runner" live example (the file is called shared/openaiAdapter.ts there).
//   1. Open https://www.ag-grid.com/studio/react/ai-direct-llm-runner/ and view the example's openaiAdapter source.
//   2. Replace the contents of THIS file with it, exporting `openaiAdapter`.
//   3. Check the call in agent.js matches that adapter's options (endpoint + key).
// Warrant already proxies the model call (POST /studio-api/llm), so the provider key never reaches the browser.
export const openaiAdapter = undefined;
