import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "obsidian-test-runtime",
      resolveId(source) {
        return source === "obsidian" ? "\0obsidian-test-runtime" : null;
      },
      load(id) {
        return id === "\0obsidian-test-runtime"
          ? [
              "export class ItemView {}",
              "export class MarkdownView {}",
              "export class Notice {}",
              "export class TFile {}",
              "export const MarkdownRenderer = { render() {} };",
              "export function setIcon() {}",
            ].join("\n")
          : null;
      },
    },
  ],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
