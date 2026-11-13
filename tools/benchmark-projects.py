"""Reproducible synthetic-only AC-15 probe. No personal config/Vault is opened.

Run from any cwd: python3 packages/work-ledger-obsidian/tools/benchmark-projects.py
Each run creates a unique capacity directory outside the source checkout.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import uuid

PACKAGE = Path(__file__).resolve().parents[1]
CLI = PACKAGE.parent / "work-ledger-cli" / "src"
sys.dont_write_bytecode = True
sys.path.insert(0, str(PACKAGE.parents[1]))
sys.path.insert(0, str(CLI))
from tools.dev_paths import development_root
from work_ledger.markdown import (project_relative_path, render_project, task_relative_path,
                                 render_task, render_journal)
from work_ledger.schema import transition_event_type
from work_ledger.store import journal_relative_path


def write(root, relative, content):
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)


def seed(root, pressure):
    created, changed = "2026-01-01T08:00:00+08:00", "2026-10-24T08:00:00+08:00"
    projects = {}
    for n in range(100):
        identifier = "project-inbox" if n == 0 else f"project-20260101-{n:03}"
        projects[identifier] = dict(schema_version=1, type="project", id=identifier,
            title="Inbox" if not n else f"合成项目 {n:03}", status="archived" if n > 90 else "active",
            visibility="private", start_date=None, end_date=None, created_at=created,
            updated_at=created, tags=[])
    tasks, events = {}, defaultdict(list)
    states = ["inbox", "planned", "in_progress", "blocked", "done", "cancelled"]
    for n in range(10000):
        day = date(2026, 1, 1) + timedelta(days=n // 999)
        identifier = f"task-{day:%Y%m%d}-{n % 999 + 1:03}"
        status = "planned" if n < 16 else states[n % 6]
        project_id = list(projects)[0 if n < 16 else n % 100]
        parent = next(reversed(tasks)) if 0 < n < 16 else None
        title = f"合成任务 {n:05}" if not pressure else ("这是用于验证中文长标题换行和日期筛选的合成任务" * 2 + f" {n:05}")
        task = dict(schema_version=1, type="task", id=identifier, title=title,
            project_id=project_id, parent_id=parent, status=status,
            initial_status=status if status in ("inbox", "planned") else "planned",
            priority=f"P{n % 4}", visibility="private",
            due_date=None if n % 5 == 0 else (date(2026, 10, 15) + timedelta(days=n % 30)).isoformat(),
            planned_for=None if n % 7 == 0 else (date(2026, 10, 15) + timedelta(days=n % 30)).isoformat(),
            created_at=created, updated_at=changed, status_changed_at=changed,
            completed_at=changed if status == "done" else None,
            tags=[f"tag-{n % 20}"] if not pressure else [f"合成标签-{x:02}-用于容量验证" for x in range(16)])
        tasks[identifier] = task
        if status not in ("inbox", "planned"):
            event_day = date(2026, 10, 1) + timedelta(days=n // 999)
            occurred = f"{event_day.isoformat()}T08:00:00+08:00"
            events[event_day.isoformat()].append(dict(schema_version=1,
                id=f"event-{event_day:%Y%m%d}-080000-{n % 999 + 1:03}", occurred_at=occurred,
                recorded_at=occurred, time_precision="exact", type=transition_event_type("planned", status),
                project_id=project_id, task_id=identifier, visibility="private",
                source="capacity-fixture", corrects=None,
                correction_reason=None, transition={"from":"planned", "to":status},
                compensates=None, summary="合成状态事件", _body=""))
    for project in projects.values():
        write(root, project_relative_path(project), render_project(project))
    for task in tasks.values():
        write(root, task_relative_path(task), render_task(task, projects, tasks))
    for day, day_events in events.items():
        write(root, journal_relative_path(day), render_journal(day, day_events, projects, tasks))


def main():
    out = development_root(PACKAGE.parents[1]) / "capacity" / str(uuid.uuid4())
    out.mkdir(parents=True)
    report = {"machine": platform.platform(), "python": platform.python_version(), "fixtures": {}}
    if sys.platform == "darwin":
        for key in ["machdep.cpu.brand_string", "hw.memsize"]:
            report[key] = subprocess.check_output(["sysctl", "-n", key], text=True).strip()
    for name, pressure in [("ordinary", False), ("long-chinese", True)]:
        root = out / name / "Vault"
        root.mkdir(parents=True)
        for args in [["init", "-q", "-b", "main"], ["config", "user.name", "Synthetic Capacity"],
                     ["config", "user.email", "synthetic@example.invalid"], ["config", "commit.gpgsign", "false"]]:
            subprocess.run(["git", "-C", str(root), *args], check=True)
        env = {**os.environ, "PYTHONPATH": str(CLI), "PYTHONDONTWRITEBYTECODE": "1",
               "WORK_LEDGER_CONFIG": str(root.parent / "config.toml"), "WORK_LEDGER_STATE_DIR": str(root.parent / "state")}
        cli = [sys.executable, "-m", "work_ledger"]
        request = root.parent / "init.json"
        request.write_text(json.dumps(dict(schema_version=1, operation_id=f"op-{uuid.uuid4()}",
            vault_path=str(root), timezone="Asia/Shanghai", git=dict(remote_name="origin", remote_url=None,
            branch="main", auto_push=False, local_only=True))), encoding="utf8")
        initialized = subprocess.run([*cli, "init", "--request-file", str(request)], env=env, capture_output=True, check=True)
        if not json.loads(initialized.stdout)["ok"]:
            raise RuntimeError("Synthetic init failed")
        seed(root, pressure)
        samples = []
        for _ in range(3):
            command = [*cli, "snapshot", "--events-from", "2026-10-01", "--events-to", "2026-10-31", "--event-limit", "1000"]
            if sys.platform == "darwin":
                command = ["/usr/bin/time", "-l", *command]
            start = time.perf_counter()
            result = subprocess.run(command, env=env, capture_output=True, timeout=60)
            elapsed = (time.perf_counter() - start) * 1000
            payload = json.loads(result.stdout)
            if not payload.get("ok"):
                raise RuntimeError(json.dumps(payload, ensure_ascii=False))
            rss = re.search(rb"(\d+)\s+maximum resident set size", result.stderr)
            samples.append({"elapsedMs": round(elapsed, 2), "peakRssBytes": int(rss[1]) if rss else None,
                "stdoutBytes": len(result.stdout), "within16MiB": len(result.stdout) <= 16 * 1024 * 1024,
                "within10Seconds": elapsed <= 10000})
            (root.parent / "snapshot.json").write_bytes(result.stdout)
        report["fixtures"][name] = {"tasks":10000, "projects":100, "maxDepth":16,
            "outputEvents":len(payload["data"]["events"]), "cliSamples": samples}
        print(json.dumps({name: report["fixtures"][name]}, ensure_ascii=False), flush=True)
    (out / "cli-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(f"Synthetic output: {out}", flush=True)


if __name__ == "__main__":
    main()
