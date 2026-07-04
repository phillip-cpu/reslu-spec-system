import type { Config } from "tailwindcss";

// RESLU brand tokens — per BUILD-SPEC.md / RESLU Brand Guide 2026.
// Palette: cream / off-white / near-white / charcoal / near-black / sand (accent only).
// Cormorant Garamond Light — display headings / cover titles ONLY.
// Helvetica Neue Light — all body / UI / tables / labels.
// No border radius anywhere in this app.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cream: "#EDE8DE",
        offwhite: "#F5F1E8",
        nearwhite: "#F7F7F7",
        charcoal: "#313131",
        nearblack: "#1A1A1A",
        sand: "#A08C72",
      },
      fontFamily: {
        sans: ['"Helvetica Neue"', "Helvetica", "Arial", "sans-serif"],
        display: ['"Cormorant Garamond"', "Georgia", "serif"],
      },
      fontWeight: {
        light: "300",
      },
      fontSize: {
        section: ["28px", { lineHeight: "1.2", fontWeight: "300" }],
        subhead: ["14px", { lineHeight: "1.4", fontWeight: "300" }],
        body: ["10px", { lineHeight: "1.6", fontWeight: "300" }],
        caption: ["8px", { lineHeight: "1.5", fontWeight: "300" }],
        label: ["7px", { lineHeight: "1", fontWeight: "700", letterSpacing: "0.14em" }],
      },
      borderRadius: {
        none: "0px",
        DEFAULT: "0px",
        sm: "0px",
        md: "0px",
        lg: "0px",
        xl: "0px",
        full: "0px",
      },
    },
  },
  plugins: [],
};

export default config;
