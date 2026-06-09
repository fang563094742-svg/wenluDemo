import { describe, expect, it } from 'vitest';

const defaultCwdByToolName: Record<string, string> = {
  verify_local_gateway_runtime_and_mcp_status: '/Users/a333/Desktop/认知奇点/claude-llm-bridge-mcp',
};

function resolveMasteredToolCwd(name: string): string {
  return defaultCwdByToolName[name] ?? process.cwd();
}

describe('mastered tool default cwd mapping', () => {
  it('routes verify_local_gateway_runtime_and_mcp_status to bridge project', () => {
    expect(resolveMasteredToolCwd('verify_local_gateway_runtime_and_mcp_status')).toBe(
      '/Users/a333/Desktop/认知奇点/claude-llm-bridge-mcp',
    );
  });

  it('falls back to process cwd for other mastered tools', () => {
    expect(resolveMasteredToolCwd('some_other_tool')).toBe(process.cwd());
  });
});
