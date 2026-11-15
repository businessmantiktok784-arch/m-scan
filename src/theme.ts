/**
 * Underground Mining Scanner — mobile design tokens.
 *
 * Dark, industrial, high-contrast: designed for readability in mine offices
 * and low-light surface camps. Amber is the single safety/action accent, teal
 * the instrument/secondary colour, red only for genuine errors. Numerals in
 * technical readouts use a tabular monospace variant.
 */
export const theme = {
  bg: "#0e1116",
  surface: "#161b22",
  surfaceHigh: "#1f2630",
  outline: "#2c3644",
  outlineStrong: "#3d4a5c",
  text: "#e8edf2",
  textMuted: "#9aa7b4",
  textFaint: "#64707d",
  amber: "#f5a524",
  amberDim: "#7a5417",
  amberContainer: "#2a2110",
  teal: "#2dd4bf",
  tealContainer: "#0f2e2a",
  danger: "#ef5350",
  dangerContainer: "#331416",
  success: "#4ade80",
} as const;

export type Theme = typeof theme;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 20 } as const;

/** Shared card surface used across all four principal screens. */
export const cardStyle = (t: Theme = theme) => ({
  backgroundColor: t.surface,
  borderRadius: radius.lg,
  borderWidth: StyleSheetHairline,
  borderColor: t.outline,
});

// Local constant so this module stays dependency-free for pure tests.
const StyleSheetHairline = 0.5;
