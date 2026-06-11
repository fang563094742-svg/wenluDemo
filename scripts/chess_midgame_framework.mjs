#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Chess } from 'chess.js';

function parseArgs(argv) {
  const args = { outdir: 'artifacts/chess_framework_run', image: '', truth: '', board: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--outdir') args.outdir = argv[++i];
    else if (a === '--image') args.image = argv[++i];
    else if (a === '--truth') args.truth = argv[++i];
    else if (a === '--board') args.board = argv[++i];
  }
  return args;
}

function materialScore(ch) {
  const vals = { p:1, n:3, b:3, r:5, q:9, k:0 };
  let score = 0;
  for (const row of ch.board()) for (const piece of row) if (piece) score += (piece.color === 'w' ? 1 : -1) * vals[piece.type];
  return score;
}

function mobilityScore(ch) {
  const turn = ch.turn();
  const own = ch.moves().length;
  const clone = new Chess(ch.fen());
  clone._turn = turn === 'w' ? 'b' : 'w';
  const opp = clone.moves().length;
  return own - opp;
}

function evaluate(ch) {
  return materialScore(ch) * 10 + mobilityScore(ch);
}

function forecastFromFen(fen, depthReplies = 12, depthFollowups = 12) {
  const game = new Chess(fen);
  const legalMoves = game.moves({ verbose: true });
  const plans = [];
  for (const move of legalMoves.slice(0, 24)) {
    const afterOur = new Chess(fen);
    const our = afterOur.move(move.san, { sloppy: true });
    if (!our) continue;
    const oppMoves = afterOur.moves({ verbose: true });
    if (!oppMoves.length) {
      plans.push({
        move: our.san,
        uci: `${our.from}${our.to}${our.promotion || ''}`,
        score: evaluate(afterOur),
        worstReply: null,
        bestRecovery: null,
        contingency: [],
        terminal: afterOur.isCheckmate() ? 'mate-now' : 'terminal',
        fen: afterOur.fen()
      });
      continue;
    }
    let worst = null;
    const contingency = [];
    for (const opp of oppMoves.slice(0, depthReplies)) {
      const afterReply = new Chess(afterOur.fen());
      afterReply.move(opp.san, { sloppy: true });
      const followups = afterReply.moves({ verbose: true });
      let bestRecovery = null;
      for (const follow of followups.slice(0, depthFollowups)) {
        const afterFollow = new Chess(afterReply.fen());
        afterFollow.move(follow.san, { sloppy: true });
        const score = evaluate(afterFollow);
        if (!bestRecovery || score > bestRecovery.score) {
          bestRecovery = { move: follow.san, score, fen: afterFollow.fen() };
        }
      }
      const branch = {
        reply: opp.san,
        replyUci: `${opp.from}${opp.to}${opp.promotion || ''}`,
        score: bestRecovery ? bestRecovery.score : evaluate(afterReply),
        whiteRecovery: bestRecovery?.move || null,
        recoveryFen: bestRecovery?.fen || afterReply.fen()
      };
      contingency.push(branch);
      if (!worst || branch.score < worst.score) worst = branch;
    }
    plans.push({
      move: our.san,
      uci: `${our.from}${our.to}${our.promotion || ''}`,
      score: worst?.score ?? evaluate(afterOur),
      worstReply: worst?.reply || null,
      bestRecovery: worst?.whiteRecovery || null,
      contingency: contingency.sort((a,b)=>a.score-b.score).slice(0,5),
      terminal: null,
      fen: afterOur.fen()
    });
  }
  return plans.sort((a,b)=>b.score-a.score);
}

function boardTextToFen(input) {
  const lines = input.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const files = 'abcdefgh';
  const rankLines = new Map();
  for (const line of lines) {
    const m = line.match(/^(\d)\s*[:.]?\s*(.+)$/);
    if (!m) continue;
    const rank = Number(m[1]);
    const raw = m[2].replace(/\s+/g, '');
    const cells = [];
    for (const ch of raw) if ('rnbqkpRNBQKP.'.includes(ch)) cells.push(ch);
    if (cells.length >= 8) rankLines.set(rank, cells.slice(0,8));
  }
  const chess = new Chess();
  chess.clear();
  for (const [rank, row] of rankLines.entries()) {
    for (let i=0;i<8;i++) {
      const piece = row[i];
      if (!piece || piece === '.') continue;
      chess.put({ type: piece.toLowerCase(), color: piece === piece.toUpperCase() ? 'w':'b' }, `${files[i]}${rank}`);
    }
  }
  chess.turn('w');
  return { fen: chess.fen(), recognizedRanks: [...rankLines.keys()].sort((a,b)=>a-b) };
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

const args = parseArgs(process.argv);
fs.mkdirSync(args.outdir, { recursive: true });
let truthPath = args.truth;
if (!truthPath) {
  run('bash', ['tools/chess_truth_capture.sh', args.outdir]);
  const files = fs.readdirSync(args.outdir).filter(f => /^chess_truth_.*\.json$/.test(f)).sort();
  truthPath = path.join(args.outdir, files[files.length - 1]);
}
const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
const imagePath = args.image || truth.screenCapture;
const ocrBin = 'scripts/.build/wenlu-ocr';
let ocrText = '';
let ocrStatus = 'skipped';
if (imagePath && fs.existsSync(imagePath) && fs.existsSync(ocrBin)) {
  try {
    ocrText = run(ocrBin, [imagePath]);
    ocrStatus = 'ok';
  } catch (e) {
    ocrText = String(e.stdout || '');
    ocrStatus = 'failed';
  }
}
const ocrPath = path.join(args.outdir, path.basename(truthPath).replace(/\.json$/, '.vision_ocr.txt'));
fs.writeFileSync(ocrPath, ocrText || '');
let source = 'unknown';
let fen = '';
let recognizedRanks = [];
if (args.board) {
  const parsed = boardTextToFen(fs.readFileSync(args.board, 'utf8'));
  fen = parsed.fen;
  recognizedRanks = parsed.recognizedRanks;
  source = 'board-text';
} else {
  const title = truth.windowTitle || '';
  const side = /白方走棋/.test(title) ? 'w' : /黑方走棋/.test(title) ? 'b' : 'w';
  const chess = new Chess();
  chess.turn(side);
  fen = chess.fen();
  source = 'window-title-fallback';
}
const plans = forecastFromFen(fen);
const result = {
  generatedAt: new Date().toISOString(),
  truthPath,
  imagePath,
  ocrPath,
  ocrStatus,
  source,
  recognizedRanks,
  frontApp: truth.frontApp,
  windowTitle: truth.windowTitle,
  fen,
  sideToMove: fen.split(' ')[1],
  candidatePlans: plans.slice(0,5),
  summary: plans[0] ? `candidate ${plans[0].move}; worst reply ${plans[0].worstReply || 'none'}; recovery ${plans[0].bestRecovery || 'none'}` : 'no-candidate-plans'
};
const outPath = path.join(args.outdir, 'midgame_framework_result.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
