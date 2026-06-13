#!/usr/bin/env tsx
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type AssertionType = 'file_exists' | 'file_contains' | 'json_field' | 'command_exit_code';
type Severity = 'hard-gate' | 'soft-signal';

type FileExistsAssertion = {
  type: 'file_exists';
  path: string;
  description: string;
  severity?: Severity;
};

type FileContainsAssertion = {
  type: 'file_contains';
  path: string;
  substring: string;
  description: string;
  severity?: Severity;
};

type JsonFieldAssertion = {
  type: 'json_field';
  path: string;
  field: string;
  equals: string | number | boolean | null;
  description: string;
  severity?: Severity;
};

type CommandExitCodeAssertion = {
  type: 'command_exit_code';
  command: string[];
  expectedExitCode?: number;
  description: string;
  severity?: Severity;
};

type Assertion = FileExistsAssertion | FileContainsAssertion | JsonFieldAssertion | CommandExitCodeAssertion;

type VerificationSpec = {
  goal: string;
  assertions: Assertion[];
};

type AssertionResult = {
  type: AssertionType;
  description: string;
  severity: Severity;
  ok: boolean;
  observed: Record<string, unknown>;
  error?: string;
};

type VerificationReport = {
  goal: string;
  specPath: string;
  generatedAt: string;
  ok: boolean;
  hardGateFailures: number;
  softSignalFailures: number;
  results: AssertionResult[];
};

function getSeverity(assertion: Assertion): Severity {
  return assertion.severity ?? 'hard-gate';
}

function getByPath(input: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, input);
}

async function runPowerShell(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const script = command.join(' ');
  try {
    const { stdout, stderr } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ]);
    return { exitCode: 0, stdout, stderr };
  } catch (error: unknown) {
    const cast = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof cast.code === 'number' ? cast.code : 1,
      stdout: cast.stdout ?? '',
      stderr: cast.stderr ?? cast.message ?? ''
    };
  }
}

async function evaluateAssertion(assertion: Assertion): Promise<AssertionResult> {
  const severity = getSeverity(assertion);
  try {
    if (assertion.type === 'file_exists') {
      const fullPath = resolve(assertion.path);
      await access(fullPath, constants.F_OK);
      const fileStat = await stat(fullPath);
      return {
        type: assertion.type,
        description: assertion.description,
        severity,
        ok: true,
        observed: { path: fullPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs }
      };
    }

    if (assertion.type === 'file_contains') {
      const fullPath = resolve(assertion.path);
      const content = await readFile(fullPath, 'utf8');
      const ok = content.includes(assertion.substring);
      return {
        type: assertion.type,
        description: assertion.description,
        severity,
        ok,
        observed: { path: fullPath, substring: assertion.substring, contentLength: content.length }
      };
    }

    if (assertion.type === 'json_field') {
      const fullPath = resolve(assertion.path);
      const payload = JSON.parse(await readFile(fullPath, 'utf8')) as unknown;
      const actual = getByPath(payload, assertion.field);
      const ok = actual === assertion.equals;
      return {
        type: assertion.type,
        description: assertion.description,
        severity,
        ok,
        observed: { path: fullPath, field: assertion.field, actual, expected: assertion.equals }
      };
    }

    const expectedExitCode = assertion.expectedExitCode ?? 0;
    const commandResult = await runPowerShell(assertion.command);
    return {
      type: assertion.type,
      description: assertion.description,
      severity,
      ok: commandResult.exitCode === expectedExitCode,
      observed: {
        command: assertion.command,
        expectedExitCode,
        actualExitCode: commandResult.exitCode,
        stdout: commandResult.stdout.trim(),
        stderr: commandResult.stderr.trim()
      }
    };
  } catch (error: unknown) {
    return {
      type: assertion.type,
      description: assertion.description,
      severity,
      ok: false,
      observed: {},
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main(): Promise<void> {
  const specArg = process.argv[2];
  const outputArg = process.argv[3] ?? 'task_output/verification/latest-verification-report.json';
  if (!specArg) {
    throw new Error('usage: tsx scripts/verificationRunner.ts <spec.json> [output.json]');
  }

  const specPath = resolve(specArg);
  const outputPath = resolve(outputArg);
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as VerificationSpec;
  if (!spec.goal || !Array.isArray(spec.assertions)) {
    throw new Error('Invalid verification spec: require goal and assertions[]');
  }

  const results: AssertionResult[] = [];
  for (const assertion of spec.assertions) {
    results.push(await evaluateAssertion(assertion));
  }

  const hardGateFailures = results.filter((result) => result.severity === 'hard-gate' && !result.ok).length;
  const softSignalFailures = results.filter((result) => result.severity === 'soft-signal' && !result.ok).length;
  const report: VerificationReport = {
    goal: spec.goal,
    specPath,
    generatedAt: new Date().toISOString(),
    ok: hardGateFailures === 0,
    hardGateFailures,
    softSignalFailures,
    results
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: report.ok, outputPath, hardGateFailures, softSignalFailures }, null, 2));
  if (!report.ok) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
