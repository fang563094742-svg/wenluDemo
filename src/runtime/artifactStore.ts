/**
 * artifactStore.ts — 物理载体分离层。
 *
 * 解决的问题：不能把所有东西塞进一个 JSON（截图、diff、长输出、网页内容会撑爆）。
 *
 * 设计：
 * - 逻辑真相源唯一（agentState 是逻辑主体）
 * - 物理载体分三层：
 *   1. agent-state.snapshot.json — 当前快照（小，原子覆写）
 *   2. action-ledger.ndjson — 追加式账本（只追加，不改历史）
 *   3. artifacts/ — 大 blob 存储（内容寻址，文件名=sha256 前缀+类型后缀）
 *
 * Artifact 本身不进 agentState，只有引用（artifactRef）进入。
 */

import { createHash } from "crypto";
import { mkdir, writeFile, readFile, unlink, readdir, stat } from "fs/promises";
import { join, extname } from "path";

// ═══════════════════════════════════════════════════════════════════════
// Artifact 类型
// ═══════════════════════════════════════════════════════════════════════

export type ArtifactKind =
  | "stdout"         // 命令输出
  | "stderr"         // 错误输出
  | "file-diff"      // 文件变更 diff
  | "file-snapshot"  // 文件完整快照
  | "http-response"  // HTTP 响应体
  | "browser-screenshot"  // 浏览器截图
  | "web-page"       // 网页内容
  | "json-blob"      // 结构化 JSON 大对象
  | "log"            // 日志片段
  ;

export interface ArtifactRef {
  id: string;           // sha256 前 16 位
  kind: ArtifactKind;
  storedAt: string;     // 相对路径
  sizeBytes: number;
  createdAt: string;
  summary?: string;     // 人类可读摘要（< 200 chars）
}

export interface ArtifactMetadata {
  kind: ArtifactKind;
  source?: string;      // 来源（工具名/任务ID）
  summary?: string;
  tags?: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// Store 接口
// ═══════════════════════════════════════════════════════════════════════

export interface ArtifactStore {
  store(content: string | Buffer, metadata: ArtifactMetadata): Promise<ArtifactRef>;
  retrieve(ref: ArtifactRef): Promise<string | null>;
  retrieveById(id: string): Promise<string | null>;
  delete(ref: ArtifactRef): Promise<boolean>;
  list(filter?: { kind?: ArtifactKind; since?: string }): Promise<ArtifactRef[]>;
  totalSize(): Promise<number>;
  gc(maxAgeDays?: number, maxTotalBytes?: number): Promise<number>;
}

// ═══════════════════════════════════════════════════════════════════════
// 实现
// ═══════════════════════════════════════════════════════════════════════

export async function createArtifactStore(baseDir: string): Promise<ArtifactStore> {
  const artifactsDir = join(baseDir, "artifacts");
  const indexPath = join(baseDir, "artifact-index.ndjson");
  await mkdir(artifactsDir, { recursive: true });

  // 内存索引（启动时从 ndjson 加载）
  const index: Map<string, ArtifactRef> = new Map();

  // 尝试加载已有索引
  try {
    const content = await readFile(indexPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ref = JSON.parse(line) as ArtifactRef;
        index.set(ref.id, ref);
      } catch { /* skip malformed lines */ }
    }
  } catch { /* no existing index, start fresh */ }

  function computeId(content: string | Buffer): string {
    const hash = createHash("sha256");
    hash.update(content);
    return hash.digest("hex").slice(0, 16);
  }

  function extensionForKind(kind: ArtifactKind): string {
    switch (kind) {
      case "stdout":
      case "stderr":
      case "log":
        return ".txt";
      case "file-diff":
        return ".diff";
      case "file-snapshot":
      case "web-page":
        return ".txt";
      case "http-response":
        return ".txt";
      case "browser-screenshot":
        return ".png";
      case "json-blob":
        return ".json";
      default:
        return ".bin";
    }
  }

  async function appendIndex(ref: ArtifactRef): Promise<void> {
    const line = JSON.stringify(ref) + "\n";
    await writeFile(indexPath, line, { flag: "a" });
  }

  async function store(content: string | Buffer, metadata: ArtifactMetadata): Promise<ArtifactRef> {
    const id = computeId(content);
    const ext = extensionForKind(metadata.kind);
    const filename = `${id}${ext}`;
    const filePath = join(artifactsDir, filename);
    const relativePath = `artifacts/${filename}`;

    // 去重：如果已存在相同 hash 的 artifact，直接返回
    if (index.has(id)) {
      return index.get(id)!;
    }

    await writeFile(filePath, content);
    const sizeBytes = Buffer.byteLength(content);

    const ref: ArtifactRef = {
      id,
      kind: metadata.kind,
      storedAt: relativePath,
      sizeBytes,
      createdAt: new Date().toISOString(),
      summary: metadata.summary?.slice(0, 200),
    };

    index.set(id, ref);
    await appendIndex(ref);

    return ref;
  }

  async function retrieve(ref: ArtifactRef): Promise<string | null> {
    try {
      const filePath = join(baseDir, ref.storedAt);
      return await readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  async function retrieveById(id: string): Promise<string | null> {
    const ref = index.get(id);
    if (!ref) return null;
    return retrieve(ref);
  }

  async function deleteArtifact(ref: ArtifactRef): Promise<boolean> {
    try {
      const filePath = join(baseDir, ref.storedAt);
      await unlink(filePath);
      index.delete(ref.id);
      return true;
    } catch {
      return false;
    }
  }

  async function list(filter?: { kind?: ArtifactKind; since?: string }): Promise<ArtifactRef[]> {
    let refs = Array.from(index.values());
    if (filter?.kind) refs = refs.filter(r => r.kind === filter.kind);
    if (filter?.since) refs = refs.filter(r => r.createdAt >= filter.since!);
    return refs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function totalSize(): Promise<number> {
    let total = 0;
    for (const ref of index.values()) {
      total += ref.sizeBytes;
    }
    return total;
  }

  async function gc(maxAgeDays: number = 7, maxTotalBytes: number = 100 * 1024 * 1024): Promise<number> {
    let removed = 0;
    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();

    // 1. 按年龄清理
    for (const [id, ref] of index.entries()) {
      if (ref.createdAt < cutoff) {
        const success = await deleteArtifact(ref);
        if (success) removed++;
      }
    }

    // 2. 按总大小清理（从最老的开始删）
    let currentSize = await totalSize();
    if (currentSize > maxTotalBytes) {
      const sorted = Array.from(index.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const ref of sorted) {
        if (currentSize <= maxTotalBytes) break;
        const success = await deleteArtifact(ref);
        if (success) {
          currentSize -= ref.sizeBytes;
          removed++;
        }
      }
    }

    return removed;
  }

  return { store, retrieve, retrieveById, delete: deleteArtifact, list, totalSize, gc };
}
