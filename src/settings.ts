import { App, PluginSettingTab, Setting } from "obsidian";

import type WorkLedgerPlugin from "./main";
import { normalizeWorkLedgerRoutes, type WorkLedgerRoute } from "./routing";

export type { WorkLedgerRoute } from "./routing";

export interface SavedFilter {
  name: string;
  query: string;
  projectId?: string;
  priorities?: string[];
  statuses?: string[];
}

export interface WorkLedgerSettings {
  executablePath: string;
  configPath?: string;
  defaultView: WorkLedgerRoute;
  eventLookbackDays: number;
  savedFilters: SavedFilter[];
  lastRoute: WorkLedgerRoute;
}

export const DEFAULT_SETTINGS: WorkLedgerSettings = {
  executablePath: "",
  defaultView: "overview",
  eventLookbackDays: 35,
  savedFilters: [],
  lastRoute: "overview",
};

export function normalizeWorkLedgerSettings(
  loaded: Partial<WorkLedgerSettings> | null,
): WorkLedgerSettings {
  const candidate = loaded ?? {};
  const routes = normalizeWorkLedgerRoutes(candidate);
  return {
    ...DEFAULT_SETTINGS,
    ...candidate,
    defaultView: routes.defaultView,
    lastRoute: routes.lastRoute,
    savedFilters: Array.isArray(candidate.savedFilters) ? candidate.savedFilters : [],
  };
}

export class WorkLedgerSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WorkLedgerPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("CLI connection").setHeading();
    new Setting(containerEl)
      .setName("Read-only boundary")
      .setDesc("The plugin only reads through work-ledger CLI. It never writes managed Markdown or runs Git commands.");
    new Setting(containerEl)
      .setName("Work-ledger executable")
      .setDesc("Absolute path to a compatible work-ledger CLI >=0.11.0,<1.0.0.")
      .addText((text) => {
        text
          .setPlaceholder("/absolute/path/work-ledger")
          .setValue(this.plugin.settings.executablePath)
          .onChange(async (value) => {
            this.plugin.settings.executablePath = value.trim();
            await this.plugin.saveSettingsAndReconnect();
          });
      });
    new Setting(containerEl)
      .setName("Configuration file")
      .setDesc("Optional absolute config path. Leave empty to use work-ledger's default.")
      .addText((text) => {
        text
          .setPlaceholder("/absolute/path/config.toml")
          .setValue(this.plugin.settings.configPath ?? "")
          .onChange(async (value) => {
            this.plugin.settings.configPath = value.trim() || undefined;
            await this.plugin.saveSettingsAndReconnect();
          });
      });
    new Setting(containerEl)
      .setName("Default page")
      .setDesc("Page shown when no previous work ledger route exists.")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            overview: "Overview",
            projects: "Projects",
            knowledge: "Knowledge",
            timeline: "Timeline",
            reports: "Reports",
            health: "Health",
          })
          .setValue(this.plugin.settings.defaultView)
          .onChange(async (value) => {
            this.plugin.settings.defaultView = value as WorkLedgerRoute;
            await this.plugin.saveSettings();
          });
      });
    new Setting(containerEl)
      .setName("Event lookback")
      .setDesc("Days included in the initial read-only snapshot (1–365).")
      .addText((text) => {
        text
          .setPlaceholder("35")
          .setValue(String(this.plugin.settings.eventLookbackDays))
          .onChange(async (value) => {
            const days = Number(value);
            if (Number.isInteger(days) && days >= 1 && days <= 365) {
              this.plugin.settings.eventLookbackDays = days;
              await this.plugin.saveSettingsAndReconnect();
            }
          });
      });
  }
}
