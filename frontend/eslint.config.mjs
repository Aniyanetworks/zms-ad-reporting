import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // `_foo` is the convention for intentionally unused destructured values.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // React Compiler rules: the codebase hydrates a few pieces of state from
      // localStorage / props inside effects. Surface them, don't fail CI on them.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
  globalIgnores([".next/**", "node_modules/**", "next-env.d.ts", "coverage/**"]),
]);
