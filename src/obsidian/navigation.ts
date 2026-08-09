import { type App, MarkdownView, Notice, TFile } from "obsidian";

export async function openVaultPath(app: App, path: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    new Notice(`Work Ledger file is unavailable: ${path}`);
    return;
  }
  await app.workspace.getLeaf(false).openFile(file);
}

export async function openJournalEvent(app: App, path: string, eventId: string): Promise<void> {
  await openVaultPath(app, path);
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view || view.file?.path !== path) {
    return;
  }
  const line = view.editor
    .getValue()
    .split("\n")
    .findIndex((value) => value.includes(`"id":"${eventId}"`));
  if (line < 0) {
    new Notice("The event position changed. Refresh work ledger to locate it again.");
    return;
  }
  view.editor.setCursor({ line, ch: 0 });
  view.editor.scrollIntoView(
    {
      from: { line, ch: 0 },
      to: { line: Math.min(line + 3, view.editor.lineCount() - 1), ch: 0 },
    },
    true,
  );
}
