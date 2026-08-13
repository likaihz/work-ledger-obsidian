import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist/**",
    "main.js",
    "coverage",
    ".e2e/**",
    "tests/fixtures",
    "esbuild.config.mjs",
    "manifest.json",
    "versions.json",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.mts",
            "vitest.config.ts",
            "tools/package.mjs",
            "tools/local-e2e.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/settings.ts"],
    rules: {
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
    },
  },
  {
    files: ["tools/local-e2e.mjs"],
    rules: {
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/prefer-window-timers": "off",
    },
  },
);
