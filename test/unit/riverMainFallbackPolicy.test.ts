import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const riverMain = readFileSync('src/riverMain.ts', 'utf-8');

describe('riverMain fallback reply policy', () => {
  it('does not use default soothing catchphrase as fallback reply', () => {
    expect(riverMain).not.toContain('const fallback = messages.length > 1 ? "嗯，我在。" : "嗯，我在。";');
    expect(riverMain).not.toContain('return "嗯，我在。"');
  });

  it('documents policy to avoid soothing opener regression under pressure', () => {
    expect(riverMain).toContain('禁止滑回默认安抚口头禅');
    expect(riverMain).toContain('不做情绪安抚式起手');
  });

  it('does not keep a fixed fallback sentence template assembly', () => {
    expect(riverMain).not.toContain('const fallbackParts = [');
    expect(riverMain).not.toContain("const fallback = fallbackParts.join(' ');");
  });

  it('requires fallback to be generated from live state instead of canned copy', () => {
    expect(riverMain).toContain('buildMinimalFallbackReply(');
    expect(riverMain).toContain('不能复用旧安抚口头禅');
  });
});
