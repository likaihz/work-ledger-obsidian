import { Notice, Plugin, type TAbstractFile, type WorkspaceLeaf } from "obsidian";

import {
  DEFAULT_SETTINGS,
  WorkLedgerSettingTab,
  type WorkLedgerRoute,
  type WorkLedgerSettings,
} from "./settings";
import { currentVaultIdentity } from "./obsidian/vault-identity";
import { LedgerStore } from "./state/ledger-store";
import { RefreshController } from "./state/refresh-controller";
import {
  WORK_LEDGER_VIEW_TYPE,
  WorkLedgerView,
  type WorkLedgerViewHost,
} from "./views/work-ledger-view";

export default class WorkLedgerPlugin extends Plugin implements WorkLedgerViewHost {
  settings: WorkLedgerSettings = DEFAULT_SETTINGS;
  readonly store = new LedgerStore();
  private refreshController: RefreshController | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(
      WORK_LEDGER_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new WorkLedgerView(leaf, this),
    );
    this.addRibbonIcon("notebook-tabs", "Open work ledger", () => void this.activateView());
    this.addCommand({
      id: "open",
      name: "Open",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "refresh",
      name: "Refresh read-only snapshot",
      callback: () => {
        if (!this.refreshController) {
          new Notice("Work ledger is waiting for the Obsidian layout.");
          return;
        }
        void this.refreshController.refresh(false);
      },
    });
    this.addCommand({
      id: "search",
      name: "Focus search",
      callback: () => {
        const view = this.findOpenView();
        if (view) {
          view.focusSearch();
        } else {
          void this.activateView().then(() => this.findOpenView()?.focusSearch());
        }
      },
    });
    for (const route of ["overview", "projects", "timeline", "reports", "health"] as WorkLedgerRoute[]) {
      this.addCommand({
        id: `open-${route}`,
        name: `Open ${route[0]?.toLocaleUpperCase() ?? ""}${route.slice(1)}`,
        callback: () => void this.activateView(route),
      });
    }
    this.addSettingTab(new WorkLedgerSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.refreshController = new RefreshController(
        this.store,
        () => ({
          executablePath: this.settings.executablePath,
          ...(this.settings.configPath ? { configPath: this.settings.configPath } : {}),
          eventLookbackDays: this.settings.eventLookbackDays,
        }),
        () => currentVaultIdentity(this.app),
      );
      this.registerVaultListeners();
      void this.refreshController.start();
    });
  }

  onunload(): void {
    this.refreshController?.dispose();
    this.refreshController = null;
  }

  controller(): RefreshController | null {
    return this.refreshController;
  }

  async activateView(route?: WorkLedgerRoute): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(WORK_LEDGER_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: WORK_LEDGER_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (route && view instanceof WorkLedgerView) {
      await view.setRoute(route);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveSettingsAndReconnect(): Promise<void> {
    await this.saveSettings();
    if (this.refreshController) {
      await this.refreshController.refresh(true);
    }
  }

  async saveRoute(route: WorkLedgerRoute): Promise<void> {
    this.settings.lastRoute = route;
    await this.saveSettings();
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<WorkLedgerSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(loaded ?? {}),
      savedFilters: Array.isArray(loaded?.savedFilters) ? loaded.savedFilters : [],
    };
  }

  private registerVaultListeners(): void {
    const schedule = (file: TAbstractFile) => {
      if (isManagedPath(file.path)) {
        this.refreshController?.scheduleRefresh();
      }
    };
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));
  }

  private findOpenView(): WorkLedgerView | null {
    for (const leaf of this.app.workspace.getLeavesOfType(WORK_LEDGER_VIEW_TYPE)) {
      if (leaf.view instanceof WorkLedgerView) {
        return leaf.view;
      }
    }
    return null;
  }
}

function isManagedPath(path: string): boolean {
  return (
    path === "Work/.work-ledger.json" ||
    path.startsWith("Work/Projects/") ||
    path.startsWith("Work/Tasks/") ||
    path.startsWith("Work/Journal/") ||
    path.startsWith("Work/Reports/")
  );
}
