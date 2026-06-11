#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

type FileDecision = {
  path: string;
  category: 'commit' | 'ignore' | 'review';
  reason: string;
};

type RepoPlan = {
  repoPath: string;
  repoName: string;
  exists: boolean;
  git: boolean;
  branch?: string;
  modifiedTracked: string[];
  untracked: string[];
  ignoreSuggestions: string[];
  decisions: FileDecision[];
  commitCandidates: string[];
  reviewCandidates: string[];
  ignoreCandidates: string[];
  addCommand?: string;
};

type Output = {
  generatedAt: string;
  root: string;
  clipboardIntent: string;
  repos: RepoPlan[];
  summary: {
    existingRepos: number;
    missingRepos: string[];
    totalCommitCandidates: number;
    totalIgnoreCandidates: number;
    totalReviewCandidates: number;
  };
};

const defaultIgnorePatterns = [
  '.DS_Store',
  'node_modules/',
  'dist/',
  '.runtime/',
  '.taskline_artifacts/',
  '.taskline_backups/',
  '.wenlu_sensors/',
  '.codex/',
  '.claude/',
  'artifacts/',
  'task_output/',
  'diagnostic/',
  '*.log',
  'coverage/',
  'playwright-report/',
  'test-results/',
  '__tests__/',
  'tests/',
  'tmp/',
  'temp/',
  '.cache/',
  'data/runtime/',
  '用户数据/'
];

const ignoreMatchers = [
  /^\.runtime\//,
  /^\.taskline_artifacts\//,
  /^\.taskline_backups\//,
  /^\.wenlu_sensors\//,
  /^\.codex\//,
  /^\.claude\//,
  /^data\/runtime\//,
  /^用户数据\//,
  /^coverage\//,
  /^playwright-report\//,
  /^test-results\//,
  /^tests?\//,
  /^tmp\//,
  /^temp\//,
  /^\.cache\//,
  /^node_modules\//,
  /^dist\//,
  /^.*\.log$/,
  /^\.DS_Store$/,
  /^.*\/\.DS_Store$/,
  /^<output_dir>\//,
  /^BROWSER_.*\.md$/,
  /^CHESS_.*\.md$/,
  /^EXTERNAL_.*\.md$/,
  /^GITHUB_GMAIL_.*\.md$/,
  /^NATIVE_APP_.*\.md$/,
  /^PLANNING_.*\.md$/,
  /^PREDICTION_CARD_.*\.md$/,
  /^SINGLE_BLOCKER_.*\.md$/,
  /^VERIFICATION_.*\.md$/
];

const reviewMatchers = [
  /^\.env(\..+)?$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^data\//,
  /^docs?\//,
  /^public\//
];

function sh(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
}

function safeSh(command: string, cwd: string): string {
  try {
    return sh(command, cwd);
  } catch {
    return '';
  }
}

function normalizeFile(rawFile: string): string {
  return rawFile.replace(/^"|"$/g, '').replace(/^\.\//, '');
}

function parseStatus(repoPath: string): { modifiedTracked: string[]; untracked: string[] } {
  const output = safeSh('git status --short', repoPath);
  const modifiedTracked: string[] = [];
  const untracked: string[] = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const status = line.slice(0, 2);
    const file = normalizeFile(line.slice(3).trim());
    if (status === '??') {
      untracked.push(file);
    } else {
      modifiedTracked.push(file);
    }
  }
  return { modifiedTracked, untracked };
}

function readGitignore(repoPath: string): string[] {
  const file = path.join(repoPath, '.gitignore');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

function classify(file: string): FileDecision {
  if (ignoreMatchers.some((matcher) => matcher.test(file))) {
    return { path: file, category: 'ignore', reason: '运行期/测试/缓存/临时产物，不应提交' };
  }
  if (reviewMatchers.some((matcher) => matcher.test(file))) {
    return { path: file, category: 'review', reason: '可能影响启动或环境，提交前应人工过一眼' };
  }
  return { path: file, category: 'commit', reason: '工程代码或必要配置，可进入提交面' };
}

function quote(file: string): string {
  return `'${file.replace(/'/g, `'\\''`)}'`;
}

function buildAddCommand(files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  return `git add ${files.map(quote).join(' ')}`;
}

function buildRepoPlan(repoPath: string): RepoPlan {
  const repoName = path.basename(repoPath);
  const exists = fs.existsSync(repoPath);
  if (!exists) {
    return {
      repoPath,
      repoName,
      exists: false,
      git: false,
      modifiedTracked: [],
      untracked: [],
      ignoreSuggestions: [],
      decisions: [],
      commitCandidates: [],
      reviewCandidates: [],
      ignoreCandidates: []
    };
  }

  const git = fs.existsSync(path.join(repoPath, '.git')) || safeSh('git rev-parse --is-inside-work-tree', repoPath) === 'true';
  if (!git) {
    return {
      repoPath,
      repoName,
      exists: true,
      git: false,
      modifiedTracked: [],
      untracked: [],
      ignoreSuggestions: [],
      decisions: [],
      commitCandidates: [],
      reviewCandidates: [],
      ignoreCandidates: []
    };
  }

  const branch = safeSh('git rev-parse --abbrev-ref HEAD', repoPath) || undefined;
  const { modifiedTracked, untracked } = parseStatus(repoPath);
  const existingIgnore = new Set(readGitignore(repoPath));
  const allPaths = [...modifiedTracked, ...untracked];
  const decisions = allPaths.map(classify);
  const commitCandidates = decisions.filter((item) => item.category === 'commit').map((item) => item.path);
  const reviewCandidates = decisions.filter((item) => item.category === 'review').map((item) => item.path);
  const ignoreCandidates = decisions.filter((item) => item.category === 'ignore').map((item) => item.path);
  const ignoreSuggestions = defaultIgnorePatterns.filter((entry) => !existingIgnore.has(entry));

  return {
    repoPath,
    repoName,
    exists: true,
    git: true,
    branch,
    modifiedTracked,
    untracked,
    ignoreSuggestions,
    decisions,
    commitCandidates,
    reviewCandidates,
    ignoreCandidates,
    addCommand: buildAddCommand(commitCandidates)
  };
}

function resolveRepos(root: string): string[] {
  const args = process.argv.slice(2);
  if (args.length > 0) return args.map((item) => path.resolve(root, item));

  const currentName = path.basename(root);
  const parent = path.dirname(root);
  const repos = [root];
  if (currentName === 'wenluDemo') {
    repos.push(path.join(parent, 'wenluDemoWeb'));
  } else {
    repos.push(path.join(root, 'wenluDemo'));
    repos.push(path.join(root, 'wenluDemoWeb'));
  }
  return repos;
}

const root = process.cwd();
const repos = resolveRepos(root).map(buildRepoPlan);
const output: Output = {
  generatedAt: new Date().toISOString(),
  root,
  clipboardIntent: '提交并推送 wenluDemo / wenluDemoWeb，只保留工程代码与启动/功能必需内容；用户数据、测试、缓存等一律忽略。',
  repos,
  summary: {
    existingRepos: repos.filter((repo) => repo.exists).length,
    missingRepos: repos.filter((repo) => !repo.exists).map((repo) => repo.repoName),
    totalCommitCandidates: repos.reduce((sum, repo) => sum + repo.commitCandidates.length, 0),
    totalIgnoreCandidates: repos.reduce((sum, repo) => sum + repo.ignoreCandidates.length, 0),
    totalReviewCandidates: repos.reduce((sum, repo) => sum + repo.reviewCandidates.length, 0)
  }
};

console.log(JSON.stringify(output, null, 2));
