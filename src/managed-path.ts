export function isManagedPath(path: string): boolean {
  return (
    path === "Work/.work-ledger.json" ||
    path.startsWith("Work/Projects/") ||
    path.startsWith("Work/Tasks/") ||
    path.startsWith("Work/Journal/") ||
    path.startsWith("Work/Knowledge/") ||
    path.startsWith("Work/Reports/")
  );
}

export function shouldRefreshManagedPath(path: string, previousPath?: string): boolean {
  return isManagedPath(path) || (previousPath !== undefined && isManagedPath(previousPath));
}
