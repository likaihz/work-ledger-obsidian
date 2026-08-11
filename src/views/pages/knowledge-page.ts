import { setIcon } from "obsidian";

import type {
  KnowledgeKind,
  KnowledgeStatus,
  LedgerKnowledge,
  LedgerProject,
} from "../../cli/protocol";
import { filterKnowledge } from "../../state/selectors";
import { badge, emptyState } from "../../ui/components";
import {
  activeKnowledgeStatuses,
  toggleKnowledgeStatus,
  type PageContext,
} from "./types";

const KNOWLEDGE_KINDS: ReadonlyArray<{
  value: KnowledgeKind;
  label: string;
}> = [
  { value: "research", label: "调研" },
  { value: "comparison", label: "比较" },
  { value: "technical_note", label: "技术笔记" },
  { value: "essay", label: "文章" },
  { value: "note", label: "笔记" },
];

const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = ["draft", "stable", "archived"];

export function renderKnowledgePage(parent: HTMLElement, context: PageContext): void {
  const { snapshot, filters: ledgerFilters, selection } = context.state;
  if (!snapshot) {
    emptyState(parent, "知识不可用", context.state.connection.message, "book-open-text");
    return;
  }

  const filters = ledgerFilters.knowledge;
  const heading = parent.createDiv({ cls: "work-ledger-page-heading work-ledger-page-heading-compact" });
  const headingCopy = heading.createDiv();
  headingCopy.createEl("h1", { text: "知识" });
  headingCopy.createEl("p", {
    text: "浏览受管 knowledge 文档；正文只会在选择后按需读取。",
    cls: "work-ledger-muted",
  });
  const counts = heading.createDiv({
    cls: "work-ledger-knowledge-counts",
    attr: { "aria-label": "知识状态计数" },
  });
  badge(counts, `draft ${countStatus(snapshot.knowledge, "draft")}`, "draft");
  badge(counts, `stable ${countStatus(snapshot.knowledge, "stable")}`, "stable");
  badge(counts, `archived ${countStatus(snapshot.knowledge, "archived")}`, "archived");

  renderFilters(parent, context);

  if (snapshot.knowledge.length === 0) {
    emptyState(parent, "暂无知识", "当前 Vault 还没有受管 Knowledge 文档。", "library-big");
    return;
  }

  const knowledgeItems = filterKnowledge(snapshot.knowledge, filters);
  if (knowledgeItems.length === 0) {
    emptyState(
      parent,
      "没有符合筛选条件的知识",
      "调整类型、状态、Project 或标签筛选后重试。",
      "list-filter",
    );
    return;
  }

  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const list = parent.createDiv({
    cls: "work-ledger-knowledge-list",
    attr: {
      role: "list",
      "aria-label": `知识列表，共 ${knowledgeItems.length} 项`,
    },
  });
  for (const knowledge of knowledgeItems) {
    renderKnowledgeCard(list, knowledge, projects.get(knowledge.projectId ?? "") ?? null, selection, context);
  }
}

function renderFilters(parent: HTMLElement, context: PageContext): void {
  const snapshot = context.state.snapshot;
  if (!snapshot) {
    return;
  }
  const filters = context.state.filters.knowledge;
  const root = parent.createEl("section", {
    cls: "work-ledger-knowledge-filters",
    attr: { "aria-label": "知识筛选" },
  });

  renderToggleFilter(
    root,
    "类型",
    KNOWLEDGE_KINDS,
    filters.kinds,
    (kind) => context.actions.setKnowledgeFilters({ kinds: toggled(filters.kinds, kind) }),
  );
  renderToggleFilter(
    root,
    "状态",
    KNOWLEDGE_STATUSES.map((status) => ({ value: status, label: status })),
    activeKnowledgeStatuses(filters.statuses),
    (status) => context.actions.setKnowledgeFilters({
      statuses: toggleKnowledgeStatus(filters.statuses, status),
    }),
  );

  const projectField = root.createDiv({ cls: "work-ledger-knowledge-filter" });
  const projectLabel = projectField.createEl("label");
  projectLabel.createSpan({ text: "Project" });
  const projectSelect = projectLabel.createEl("select", {
    attr: { "aria-label": "按 project 筛选知识" },
  });
  addOption(projectSelect, "", "全部 Project", filters.projectId === null);
  addOption(projectSelect, "none", "无 Project", filters.projectId === "none");
  for (const project of snapshot.projects) {
    addOption(projectSelect, project.id, project.title, filters.projectId === project.id);
  }
  projectSelect.addEventListener("change", () => {
    context.actions.setKnowledgeFilters({ projectId: projectSelect.value || null });
  });

  const tags = uniqueTags(snapshot.knowledge);
  const tagField = root.createDiv({ cls: "work-ledger-knowledge-filter" });
  const tagLabel = tagField.createEl("label");
  tagLabel.createSpan({ text: "标签" });
  const tagSelect = tagLabel.createEl("select", {
    attr: { "aria-label": "按标签筛选知识" },
  });
  addOption(tagSelect, "", "全部标签", filters.tag === null);
  for (const tag of tags) {
    addOption(tagSelect, tag, tag, filters.tag === tag);
  }
  tagSelect.addEventListener("change", () => {
    context.actions.setKnowledgeFilters({ tag: tagSelect.value || null });
  });
}

function renderToggleFilter<T extends string>(
  parent: HTMLElement,
  label: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  selected: ReadonlySet<T>,
  onToggle: (value: T) => void,
): void {
  const group = parent.createEl("fieldset", { cls: "work-ledger-knowledge-filter" });
  group.createEl("legend", { text: label });
  const controls = group.createDiv({ cls: "work-ledger-knowledge-filter-toggles" });
  for (const option of options) {
    const active = selected.has(option.value);
    const button = controls.createEl("button", {
      text: option.label,
      cls: `work-ledger-knowledge-filter-toggle${active ? " is-active" : ""}`,
      attr: {
        type: "button",
        "aria-pressed": String(active),
        "aria-label": `${active ? "取消" : "启用"}${label}筛选：${option.label}`,
      },
    });
    button.addEventListener("click", () => onToggle(option.value));
  }
}

function renderKnowledgeCard(
  parent: HTMLElement,
  knowledge: LedgerKnowledge,
  project: LedgerProject | null,
  selection: PageContext["state"]["selection"],
  context: PageContext,
): void {
  const selected = selection?.kind === "knowledge" && selection.id === knowledge.id;
  const shell = parent.createEl("article", {
    cls: `work-ledger-knowledge-card-shell${selected ? " is-selected" : ""}`,
    attr: { role: "listitem" },
  });
  const card = shell.createEl("button", {
    cls: "work-ledger-knowledge-card",
    attr: {
      type: "button",
      "aria-label": `查看知识 ${knowledge.title}`,
      "aria-current": selected ? "true" : "false",
      "data-knowledge-id": knowledge.id,
    },
  });
  card.addEventListener("click", () => {
    context.actions.select({ kind: "knowledge", id: knowledge.id });
  });
  card.addEventListener("dblclick", () => context.actions.openPath(knowledge.path));

  const titleRow = card.createSpan({ cls: "work-ledger-knowledge-card-heading" });
  const icon = titleRow.createSpan({ cls: "work-ledger-knowledge-icon" });
  setIcon(icon, "book-open-text");
  titleRow.createEl("strong", { text: knowledge.title, cls: "work-ledger-knowledge-title" });
  const labels = titleRow.createSpan({ cls: "work-ledger-knowledge-badges" });
  badge(labels, knowledgeKindLabel(knowledge.kind), knowledge.kind);
  badge(labels, knowledge.status, knowledge.status);

  const metadata = card.createSpan({ cls: "work-ledger-knowledge-meta" });
  metadata.createSpan({ text: project?.title ?? "无 Project" });
  metadata.createSpan({ text: `更新 ${formatUpdatedAt(knowledge.updatedAt)}` });
  metadata.createSpan({ text: `${knowledge.sourceEventIds.length} 个来源事件` });
  const tags = card.createSpan({ cls: "work-ledger-knowledge-tags" });
  if (knowledge.tags.length === 0) {
    tags.createSpan({ text: "无标签", cls: "work-ledger-muted" });
  } else {
    for (const tag of knowledge.tags) {
      tags.createSpan({ text: `#${tag}`, cls: "work-ledger-knowledge-tag" });
    }
  }

  const open = shell.createEl("button", {
    cls: "work-ledger-knowledge-open",
    attr: {
      "aria-label": `在 Obsidian 打开 ${knowledge.title}`,
      title: "在 Obsidian 打开",
    },
  });
  setIcon(open.createSpan(), "external-link");
  open.createSpan({ text: "在 Obsidian 打开" });
  open.addEventListener("click", () => context.actions.openPath(knowledge.path));
}

function toggled<T>(values: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(values);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function addOption(
  select: HTMLSelectElement,
  value: string,
  label: string,
  selected: boolean,
): void {
  select.createEl("option", { text: label, value });
  const option = select.lastElementChild;
  if (option instanceof HTMLOptionElement) {
    option.selected = selected;
  }
}

function uniqueTags(knowledge: readonly LedgerKnowledge[]): string[] {
  return [...new Set(knowledge.flatMap((item) => item.tags))].sort((left, right) =>
    left.localeCompare(right, "zh-CN"),
  );
}

function countStatus(knowledge: readonly LedgerKnowledge[], status: KnowledgeStatus): number {
  return knowledge.filter((item) => item.status === status).length;
}

function knowledgeKindLabel(kind: KnowledgeKind): string {
  return KNOWLEDGE_KINDS.find((candidate) => candidate.value === kind)?.label ?? kind;
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}
