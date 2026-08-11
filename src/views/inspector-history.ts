import type { EntityRef } from "../cli/protocol";

const DEFAULT_LIMIT = 20;

export class InspectorHistory {
  private entries: EntityRef[] = [];

  constructor(private readonly limit = DEFAULT_LIMIT) {}

  get canGoBack(): boolean {
    return this.entries.length > 0;
  }

  push(
    current: EntityRef,
    next: EntityRef,
    isAvailable: (ref: EntityRef) => boolean = () => true,
  ): boolean {
    if (sameEntity(current, next) || !isAvailable(next)) {
      return false;
    }
    this.entries.push(current);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    return true;
  }

  back(isAvailable: (ref: EntityRef) => boolean): EntityRef | null {
    while (this.entries.length > 0) {
      const target = this.entries.pop();
      if (target && isAvailable(target)) {
        return target;
      }
    }
    return null;
  }

  retain(isAvailable: (ref: EntityRef) => boolean): void {
    this.entries = this.entries.filter(isAvailable);
  }

  clear(): void {
    this.entries = [];
  }
}

function sameEntity(left: EntityRef, right: EntityRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}
