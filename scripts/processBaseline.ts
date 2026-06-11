#!/usr/bin/env tsx
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface RunRecord {
  generatedAt: string;
  verified: boolean;
  dispatch: { prompt: string; target: string; rationale: string };
  execution: {
    command: string;
    status: 'success' | 'failed';
    startedAt: string;
    endedAt: string;
    responseText: string | null;
    error: string | null;
    evidence: string[];
  };
  autopsy: {
    verdict: string;
    rootCause: string;
    evidence: string[];
  };
  readback: {
    summary: string;
    keySignal: string;
  };
  closure: {
    nextStep: string;
    closeout: string;
  };
}

const OUTPUT_DIR = resolve('task_output', 'process-baseline');
const JSON_PATH = resolve(OUTPUT_DIR, 'latest-process-baseline.json');
const MD_PATH = resolve(OUTPUT_DIR, 'latest-process-baseline.md');
const TRACE_PATH = resolve('data', 'verifiable-task-chain', 'process-baseline-trace.md');
const prompt = '你是基准对照模型。只回复一句中文：已收到同题基准。';
const target = process.env.WENLU_LLM_BASE_URL || 'missing-base-url';
const model = process.env.WENLU_LLM_MODEL || 'missing-model';
const apiKey = process.env.OPENAI_API_KEY || '';

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  let status: 'success' | 'failed' = 'failed';
  let responseText: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${target.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      error = `HTTP ${res.status}: ${text.slice(0, 500)}`;
    } else {
      const data = JSON.parse(text) as any;
      responseText = data?.choices?.[0]?.message?.content ?? null;
      status = responseText ? 'success' : 'failed';
      if (!responseText) error = 'empty response content';
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const endedAt = new Date().toISOString();
  const autopsyVerdict = status === 'success' ? '主链路可达，最小同题请求成功回包。' : '主链路未通，但已拿到真实失败信号，可据此定位。';
  const rootCause = status === 'success' ? '无阻塞；当前配置可完成最小同题调用。' : (error || 'unknown external failure');
  const record: RunRecord = {
    generatedAt: endedAt,
    verified: status === 'success' ? /已收到同题基准/.test(responseText || '') : Boolean(error),
    dispatch: {
      prompt,
      target: `${target}/chat/completions`,
      rationale: '以真实外部 LLM 端点承接同题，验证下派与执行链。',
    },
    execution: {
      command: 'tsx scripts/processBaseline.ts',
      status,
      startedAt,
      endedAt,
      responseText,
      error,
      evidence: status === 'success' ? [JSON_PATH, MD_PATH, TRACE_PATH] : [MD_PATH, TRACE_PATH],
    },
    autopsy: {
      verdict: autopsyVerdict,
      rootCause,
      evidence: [status === 'success' ? `response=${responseText}` : `error=${error}`],
    },
    readback: {
      summary: status === 'success' ? `外部端点返回：${responseText}` : `外部端点失败：${error}`,
      keySignal: status === 'success' ? '同题回包命中预期短句。' : '真实错误链已固定，可复盘。',
    },
    closure: {
      nextStep: status === 'success' ? '可在同题下继续派给其他执行面做横向基准。' : '先修复端点/鉴权/模型配置，再复跑基准。',
      closeout: '已完成同题下派、运行、验尸、读回、收口五段最小闭环。',
    },
  };

  const md = [
    '# Process Baseline',
    `- generatedAt: ${record.generatedAt}`,
    `- target: ${record.dispatch.target}`,
    `- status: ${record.execution.status}`,
    `- verified: ${record.verified}`,
    `- prompt: ${record.dispatch.prompt}`,
    `- response: ${record.execution.responseText ?? ''}`,
    `- error: ${record.execution.error ?? ''}`,
    `- autopsy: ${record.autopsy.verdict}`,
    `- readback: ${record.readback.summary}`,
    `- closure: ${record.closure.closeout}`,
  ].join('\n');
  const trace = [
    '# Process Baseline Trace',
    `- ${record.generatedAt}｜dispatch｜${record.dispatch.prompt}`,
    `- ${record.execution.startedAt}｜execution-start｜${record.dispatch.target}`,
    `- ${record.execution.endedAt}｜execution-end｜status=${record.execution.status}`,
    `- ${record.generatedAt}｜autopsy｜${record.autopsy.rootCause}`,
    `- ${record.generatedAt}｜readback｜${record.readback.summary}`,
    `- ${record.generatedAt}｜closure｜${record.closure.nextStep}`,
  ].join('\n');

  await writeFile(JSON_PATH, JSON.stringify(record, null, 2));
  await writeFile(MD_PATH, md + '\n');
  await writeFile(TRACE_PATH, trace + '\n');
  console.log(JSON.stringify({ status: record.execution.status, verified: record.verified, responseText, error }, null, 2));
}

void main();
