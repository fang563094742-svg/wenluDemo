#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

interface VerificationRecord {
  ok: boolean;
  name: string;
  verifyCmd: string;
  exitCode: number;
  shell: string;
  stdoutPath: string;
  stderrPath: string;
  stdoutPreview: string;
  stderrPreview: string;
  capturedAt: string;
  verifier: {
    name: string;
    version: number;
    deterministicSignals: string[];
  };
}

const [, , rawName = "generic_check", rawVerifyCmd = "node -e \"process.exit(0)\"", rawOutDir] = process.argv;
const outputRoot = resolve(rawOutDir || process.env.VERIFY_OUTDIR || "task_output/verification");

void main();

async function main() {
  await mkdir(outputRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const safeName = rawName.replace(/[\\/:\s]+/g, "_");
  const stdoutPath = resolve(outputRoot, `${safeName}_${stamp}.stdout.txt`);
  const stderrPath = resolve(outputRoot, `${safeName}_${stamp}.stderr.txt`);
  const jsonPath = resolve(outputRoot, `${safeName}_${stamp}.json`);

  const execution = await runCommand(rawVerifyCmd);
  await mkdir(dirname(stdoutPath), { recursive: true });
  await writeFile(stdoutPath, execution.stdout, "utf8");
  await writeFile(stderrPath, execution.stderr, "utf8");

  const record: VerificationRecord = {
    ok: execution.exitCode === 0,
    name: rawName,
    verifyCmd: rawVerifyCmd,
    exitCode: execution.exitCode,
    shell: execution.shell,
    stdoutPath,
    stderrPath,
    stdoutPreview: execution.stdout.slice(0, 1000),
    stderrPreview: execution.stderr.slice(0, 1000),
    capturedAt: new Date().toISOString(),
    verifier: {
      name: "verify_with_evidence",
      version: 2,
      deterministicSignals: [
        "shell exit code",
        "captured stdout",
        "captured stderr",
        "timestamped json envelope"
      ]
    }
  };

  await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  const persisted = JSON.parse(await readFile(jsonPath, "utf8")) as VerificationRecord;
  process.stdout.write(`${JSON.stringify({ ...persisted, jsonPath }, null, 2)}\n`);
  process.exit(execution.exitCode);
}

function runCommand(command: string): Promise<{ exitCode: number; stdout: string; stderr: string; shell: string }> {
  return new Promise((resolvePromise, reject) => {
    const shell = process.platform === "win32"
      ? `${process.env.ComSpec || "powershell.exe"} /d /s /c`
      : "/bin/sh -lc";

    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn("/bin/sh", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        shell
      });
    });
  });
}
