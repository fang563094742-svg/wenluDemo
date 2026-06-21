/**
 * 用户数据根目录解析（数据持久化层的唯一入口）
 * ------------------------------------------------------------------
 * 第一性原则：所有问路相关的用户数据都归 `wenluDemo/用户数据/`，
 * 与 PG 的 `users.id` 一一对应（per-user 子目录）。
 *
 * 优先级：
 *   1. 环境变量 WENLU_DATA_DIR （生产服务器可设别的路径，例如 /var/lib/wenlu/）
 *   2. <projectRoot>/用户数据/  （默认；项目内自包含，便于开发/迁移）
 *
 * 如果两者都不存在，直接报错退出（fail-fast），不再静默退化到旧路径。
 *
 * 注意：此文件被 riverMain.ts 的全局位置以及 UserSession.ts 的 per-user 位置
 * 共同使用——前者读 `<根>/global/...`，后者读 `<根>/users/<userId>/...`。
 */
import { resolve as resolvePath, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 默认用户数据子目录名（项目内）。 */
const DEFAULT_USER_DATA_SUBDIR = "用户数据";

/**
 * 解析 wenluDemo 项目根目录。
 * 本文件物理位置：`<projectRoot>/src/runtime/localDataDir.ts`，
 * 向上两层即项目根。
 */
function resolveProjectRoot(): string {
  // ESM 下用 import.meta.url；如果不可用则回退到 cwd
  try {
    const here = fileURLToPath(import.meta.url);
    // <root>/src/runtime/localDataDir.ts → 上两级
    return resolvePath(dirname(here), "..", "..");
  } catch {
    return process.cwd();
  }
}

let _cachedRoot: string | null = null;

/**
 * 数据根目录（全用户共享根）。
 * 默认 `<projectRoot>/用户数据/`，可经 `WENLU_DATA_DIR` 环境变量覆盖。
 *
 * 顶层结构契约：
 *   <root>/                               ← 此函数返回值
 *   ├── autonomy/                         系统级证据（不属于具体用户）
 *   ├── users/<userId>/                   per-user 数据（与 PG users.id 对齐）
 *   └── _archive/                         历史归档
 */
export function getWenluDataDir(): string {
  if (_cachedRoot) return _cachedRoot;

  // 1) 环境变量优先
  const configured = process.env.WENLU_DATA_DIR?.trim();
  if (configured) {
    _cachedRoot = resolvePath(configured);
    return _cachedRoot;
  }

  // 2) 默认 <projectRoot>/用户数据/
  const root = resolveProjectRoot();
  const dataDir = resolvePath(root, DEFAULT_USER_DATA_SUBDIR);

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  _cachedRoot = dataDir;
  return _cachedRoot;
}

/**
 * 拼接根目录下的子路径（全用户共享根的工具函数；per-user 路径应用 `getUserDataDir(userId)`）。
 *
 * 注意：在多用户架构下，多数 mind/memory/ledger 操作应改用 per-user 路径。
 * 本函数保留用于：
 *   - 系统级证据（autonomy/）
 *   - 跨用户共享配置（如有）
 *   - 临时迁移期的 system_user 兼容路径
 */
export function resolveWenluDataPath(...segments: string[]): string {
  return resolvePath(getWenluDataDir(), ...segments);
}

/**
 * 取某用户的 per-user 数据目录（`<root>/users/<userId>/`）。
 * 如果未传 userId，按 SYSTEM_USER_ID（`00000000-0000-0000-0000-000000000000`）。
 *
 * 注意：本函数返回路径并按需创建目录。
 *
 * @param userId 用户 UUID（与 PG users.id 一致）；缺省 = System_User
 */
export function getUserDataDir(userId?: string | null): string {
  const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
  const uid = (userId && userId.trim()) || SYSTEM_USER_ID;
  return resolvePath(getWenluDataDir(), "users", uid);
}

/**
 * 拼接某用户子目录下的路径。
 * 例：`resolveUserDataPath(userId, 'mind.json')` → `<root>/users/<userId>/mind.json`
 */
export function resolveUserDataPath(userId: string | null | undefined, ...segments: string[]): string {
  return resolvePath(getUserDataDir(userId), ...segments);
}

/** 仅供测试：清空缓存（让下次 getWenluDataDir 重新解析）。 */
export function _resetCacheForTests(): void {
  _cachedRoot = null;
}
