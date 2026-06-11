/**
 * verification/index.ts — 结构化验证层统一出口。
 */

export type {
  Assertion,
  AssertionResult,
  AssertionContext,
  AssertionSeverity,
  ProbeType,
  ExpectType,
  EvidenceType,
  CollectedEvidence,
  VerificationResult,
} from "./assertionTypes.js";

export {
  shellAssertion,
  httpAssertion,
  fileAssertion,
  stateAssertion,
} from "./assertionTypes.js";

export type { VerificationEngine } from "./verificationEngine.js";
export { createVerificationEngine } from "./verificationEngine.js";

export type { EvidenceQuery, EvidenceEntry, EvidenceCollector } from "./evidenceCollector.js";
export { createEvidenceCollector } from "./evidenceCollector.js";
