import { execFile } from "node:child_process";
import path from "node:path";

import {
  decodeCapabilities,
  decodeDoctor,
  decodeReportExport,
  decodeSnapshot,
  decodeSuccessData,
  decodeVersion,
  type CapabilityInfo,
  type DoctorResult,
  type LedgerSnapshot,
  type ReportExport,
  type VersionInfo,
} from "./protocol";

const MAX_STDOUT = 16 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type CliErrorKind =
  | "configuration"
  | "missing"
  | "timeout"
  | "output"
  | "protocol"
  | "cli"
  | "cancelled";

export class CliInvocationError extends Error {
  constructor(
    public readonly kind: CliErrorKind,
    message: string,
    public readonly code?: string,
    public readonly details?: JsonRecord,
  ) {
    super(message);
    this.name = "CliInvocationError";
  }
}

export interface LedgerCliClientOptions {
  executablePath: string;
  configPath?: string;
  timeoutMs?: number;
}

export interface LedgerReadClient {
  version(signal?: AbortSignal): Promise<VersionInfo>;
  capabilities(signal?: AbortSignal): Promise<CapabilityInfo>;
  snapshot(
    eventsFrom: string,
    eventsTo: string,
    eventLimit: number,
    signal?: AbortSignal,
  ): Promise<LedgerSnapshot>;
  projectShow(id: string, signal?: AbortSignal): Promise<JsonRecord>;
  taskShow(id: string, signal?: AbortSignal): Promise<JsonRecord>;
  eventShow(id: string, view: "effective" | "audit", signal?: AbortSignal): Promise<JsonRecord>;
  reportDue(at: string, signal?: AbortSignal): Promise<JsonRecord>;
  reportFacts(
    week: string,
    audience: "personal" | "reportable",
    signal?: AbortSignal,
  ): Promise<JsonRecord>;
  reportExport(
    week: string,
    audience: "personal" | "reportable",
    format: "markdown" | "text",
    signal?: AbortSignal,
  ): Promise<ReportExport>;
  doctor(signal?: AbortSignal): Promise<DoctorResult>;
  migrationPlan(targetVersion: number, signal?: AbortSignal): Promise<JsonRecord>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSingleJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new CliInvocationError("output", "work-ledger returned empty stdout.");
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!isRecord(value)) {
      throw new CliInvocationError("output", "work-ledger stdout must be one JSON object.");
    }
    return value;
  } catch (error) {
    if (error instanceof CliInvocationError) {
      throw error;
    }
    throw new CliInvocationError("output", "work-ledger stdout was not exactly one JSON object.");
  }
}

function cliFailure(payload: unknown): CliInvocationError | null {
  if (!isRecord(payload) || payload.ok !== false || !isRecord(payload.error)) {
    return null;
  }
  const code = typeof payload.error.code === "string" ? payload.error.code : "CLI_ERROR";
  const message = typeof payload.error.message === "string" ? payload.error.message : "work-ledger failed.";
  const details = isRecord(payload.error.details) ? payload.error.details : {};
  return new CliInvocationError("cli", message, code, details);
}

function redactStderr(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1***@")
    .replace(/([?&](?:token|access_token|password)=)[^&\s]+/gi, "$1***")
    .slice(0, 4_000);
}

export class LedgerCliClient implements LedgerReadClient {
  private readonly executablePath: string;
  private readonly configPath?: string;
  private readonly timeoutMs: number;

  constructor(options: LedgerCliClientOptions) {
    if (!path.isAbsolute(options.executablePath)) {
      throw new CliInvocationError("configuration", "The work-ledger executable path must be absolute.");
    }
    if (options.configPath && !path.isAbsolute(options.configPath)) {
      throw new CliInvocationError("configuration", "The work-ledger config path must be absolute.");
    }
    this.executablePath = options.executablePath;
    this.configPath = options.configPath;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private run(args: string[], signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<unknown> {
    const environment = { ...process.env };
    if (this.configPath) {
      environment.WORK_LEDGER_CONFIG = this.configPath;
    }
    return new Promise((resolve, reject) => {
      execFile(
        this.executablePath,
        args,
        {
          env: environment,
          encoding: "utf8",
          maxBuffer: MAX_STDOUT,
          timeout: timeoutMs,
          windowsHide: true,
          signal,
        },
        (error, stdout, stderr) => {
          let payload: unknown;
          try {
            payload = parseSingleJson(stdout);
          } catch (parseError) {
            if (signal?.aborted) {
              reject(new CliInvocationError("cancelled", "work-ledger request was cancelled."));
              return;
            }
            if (error && "code" in error && error.code === "ENOENT") {
              reject(new CliInvocationError("missing", "The configured work-ledger executable does not exist."));
              return;
            }
            if (error && "killed" in error && error.killed) {
              reject(new CliInvocationError("timeout", "work-ledger exceeded the allowed execution time."));
              return;
            }
            const diagnostic = redactStderr(stderr);
            reject(
              new CliInvocationError(
                "output",
                diagnostic ? `${String((parseError as Error).message)} ${diagnostic}` : String((parseError as Error).message),
              ),
            );
            return;
          }
          const failure = cliFailure(payload);
          if (failure) {
            reject(failure);
            return;
          }
          if (error) {
            reject(
              new CliInvocationError(
                "cli",
                redactStderr(stderr) || `work-ledger exited unsuccessfully: ${String(error.message)}`,
              ),
            );
            return;
          }
          resolve(payload);
        },
      );
    });
  }

  async version(signal?: AbortSignal): Promise<VersionInfo> {
    return decodeVersion(await this.run(["version"], signal));
  }

  async capabilities(signal?: AbortSignal): Promise<CapabilityInfo> {
    return decodeCapabilities(await this.run(["capabilities"], signal));
  }

  async snapshot(
    eventsFrom: string,
    eventsTo: string,
    eventLimit: number,
    signal?: AbortSignal,
  ): Promise<LedgerSnapshot> {
    return decodeSnapshot(
      await this.run(
        [
          "snapshot",
          "--events-from",
          eventsFrom,
          "--events-to",
          eventsTo,
          "--event-limit",
          String(eventLimit),
        ],
        signal,
      ),
    );
  }

  async projectShow(id: string, signal?: AbortSignal): Promise<JsonRecord> {
    return decodeSuccessData(await this.run(["project", "show", "--id", id], signal));
  }

  async taskShow(id: string, signal?: AbortSignal): Promise<JsonRecord> {
    return decodeSuccessData(await this.run(["task", "show", "--id", id], signal));
  }

  async eventShow(id: string, view: "effective" | "audit", signal?: AbortSignal): Promise<JsonRecord> {
    return decodeSuccessData(
      await this.run(["event", "show", "--id", id, "--view", view], signal),
    );
  }

  async reportDue(at: string, signal?: AbortSignal): Promise<JsonRecord> {
    return decodeSuccessData(await this.run(["report", "due", "--at", at], signal, 30_000));
  }

  async reportFacts(
    week: string,
    audience: "personal" | "reportable",
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return decodeSuccessData(
      await this.run(
        ["report", "facts", "--week", week, "--audience", audience, "--source", "latest"],
        signal,
        30_000,
      ),
    );
  }

  async reportExport(
    week: string,
    audience: "personal" | "reportable",
    format: "markdown" | "text",
    signal?: AbortSignal,
  ): Promise<ReportExport> {
    return decodeReportExport(
      await this.run(
        ["report", "export", "--week", week, "--audience", audience, "--format", format],
        signal,
        30_000,
      ),
    );
  }

  async doctor(signal?: AbortSignal): Promise<DoctorResult> {
    return decodeDoctor(await this.run(["doctor", "--scope", "all"], signal, 30_000));
  }

  async migrationPlan(targetVersion: number, signal?: AbortSignal): Promise<JsonRecord> {
    return decodeSuccessData(
      await this.run(["migrate", "plan", "--to", String(targetVersion)], signal, 30_000),
    );
  }
}

export function isCompatibleCliVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[a-z0-9.-]*)?$/i.exec(version);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && minor >= 8;
}
