#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TMP_IMG="${1:-native_app_probe/evidence/chess_truth_2026-06-10T10-47-58Z.png}"
OCR_OUT="$(scripts/.build/wenlu-ocr "$TMP_IMG" 2>/dev/null || true)"
export OCR_OUT
export TMP_IMG
node --input-type=module <<'NODE'
import { Chess } from 'chess.js';
const ocr = process.env.OCR_OUT || '';
const sourceImage = process.env.TMP_IMG || '';
const lines = ocr.split('\n').map(s => s.trim()).filter(Boolean);
const pairs = [];
const pairRegex = /([KQRBN]?[a-h][1-8])\s*([-x])\s*([a-h][1-8])(?:\s*=?\s*([QRBN]))?/g;
for (const line of lines) {
  let match;
  while ((match = pairRegex.exec(line)) !== null) {
    const [, fromWithPiece, op, to, promo] = match;
    const piecePrefix = /^[KQRBN]/.test(fromWithPiece) ? fromWithPiece[0] : '';
    const from = piecePrefix ? fromWithPiece.slice(1) : fromWithPiece;
    let uci = `${from}${to}`;
    if (promo) uci += promo.toLowerCase();
    pairs.push({ raw: match[0], from, to, op, piecePrefix, uci });
  }
}
const game = new Chess();
const applied = [];
const rejected = [];
for (const pair of pairs) {
  try {
    const move = game.move({ from: pair.from, to: pair.to, promotion: pair.uci[4] }, { sloppy: true });
    if (move) applied.push({ raw: pair.raw, san: move.san, uci: pair.uci });
    else rejected.push(pair);
  } catch {
    rejected.push(pair);
  }
}
function materialScore(ch) {
  const vals = { p:1, n:3, b:3, r:5, q:9, k:0 };
  let score = 0;
  for (const row of ch.board()) for (const piece of row) if (piece) score += (piece.color === 'w' ? 1 : -1) * vals[piece.type];
  return score;
}
function forecastRootMove(rootSan) {
  const afterOur = new Chess(game.fen());
  const our = afterOur.move(rootSan, { sloppy: true });
  if (!our) return null;
  const oppMoves = afterOur.moves({ verbose: true });
  if (oppMoves.length === 0) {
    return { move: our.san, worstReply: null, score: materialScore(afterOur), lineType: afterOur.isCheckmate() ? 'mate-now' : 'terminal', fen: afterOur.fen() };
  }
  let worstScore = Infinity;
  let worstReply = null;
  let worstFen = afterOur.fen();
  for (const opp of oppMoves) {
    const afterReply = new Chess(afterOur.fen());
    afterReply.move(opp.san, { sloppy: true });
    const ourFollowups = afterReply.moves({ verbose: true });
    let bestRecovery = -Infinity;
    let bestRecoverySan = null;
    for (const follow of ourFollowups.slice(0, 20)) {
      const afterFollow = new Chess(afterReply.fen());
      afterFollow.move(follow.san, { sloppy: true });
      const score = materialScore(afterFollow);
      if (score > bestRecovery) {
        bestRecovery = score;
        bestRecoverySan = follow.san;
      }
    }
    const branchScore = bestRecovery === -Infinity ? materialScore(afterReply) : bestRecovery;
    if (branchScore < worstScore) {
      worstScore = branchScore;
      worstReply = opp.san;
      worstFen = afterReply.fen();
    }
    opp.bestWhiteRecovery = bestRecoverySan;
    opp.branchScore = branchScore;
  }
  const contingency = oppMoves
    .map(m => ({ reply: m.san, whiteRecovery: m.bestWhiteRecovery, score: m.branchScore }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);
  return { move: our.san, worstReply, score: worstScore, lineType: 'forecast', fen: worstFen, contingency };
}
const legalMoves = game.moves({ verbose: true });
const candidatePlans = legalMoves.slice(0, 15).map(m => forecastRootMove(m.san)).filter(Boolean).sort((a,b)=>b.score-a.score);
const result = {
  frontApp: 'Chess',
  sourceImage,
  parsedMovePairs: pairs,
  appliedMoves: applied,
  rejectedMoves: rejected,
  currentFen: game.fen(),
  sideToMove: game.turn(),
  legalMoveCount: legalMoves.length,
  candidatePlans,
  summary: candidatePlans[0] ? `best ${candidatePlans[0].move}; worst reply ${candidatePlans[0].worstReply}; fallback ${candidatePlans[0].contingency?.[0]?.whiteRecovery || 'none'}` : 'no-candidates'
};
console.log(JSON.stringify(result, null, 2));
NODE
