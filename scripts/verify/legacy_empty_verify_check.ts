import { createVerificationEngine } from '../../src/verification/verificationEngine.js';

async function main() {
  const engine = createVerificationEngine();
  const result = await engine.verifyLegacy('deterministic-empty-verify', '');

  if (result.overallVerdict !== 'failed') {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  if (!result.assertions[0]?.evidence?.summary?.includes('missing cmd')) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    taskId: result.taskId,
    verdict: result.overallVerdict,
    summary: result.assertions[0]?.evidence?.summary,
  }, null, 2));
}

void main();
