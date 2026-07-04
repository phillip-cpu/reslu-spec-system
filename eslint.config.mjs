import next from "eslint-config-next";

// Flat config (ESLint 9). eslint-config-next 16 ships a native flat
// config array, so we spread it directly (FlatCompat is incompatible
// with it). Replaces the legacy .eslintrc.json.
export default [
  ...next,
  {
    ignores: [".next/**", "node_modules/**", "supabase/**", "*.config.*"],
  },
];
