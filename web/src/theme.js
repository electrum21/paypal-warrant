import { studioTheme } from "ag-studio";

// PayPal-flavoured theme. Studio shares AG Grid's theming API, so params and CSS variables work the same way.
// Shared params affect the Studio UI, grid widgets and chart widgets together.
export const warrantTheme = studioTheme.withParams({
  accentColor: "#0070ba",
  backgroundColor: "#ffffff",
  foregroundColor: "#14213d",
  fontFamily: { googleFont: "Inter" },
  browserColorScheme: "light",
});

// Colours for the decisions Warrant can propose. Used by the custom widget and the page chrome so they match.
export const ACTION_COLOURS = {
  contest: "#0f6e6e",
  offer_partial_refund: "#a86414",
  accept_claim: "#a63a3a",
  escalate_to_human: "#55606e",
  none: "#55606e",
};
