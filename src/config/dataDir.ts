/**
 * 用户数据根目录解析（单一来源，钉死）。
 *
 * 彻底整改（数据归位）：问路的所有运行数据——mind.json、memory.json、感知器官 sensors/、
 * 自进化代码 self_code/、各用户数据 users/{id}/、备份 backups/——统一归到**项目内的
 * 「用户数据」目录** `<PROJECT_ROOT>/用户数据/`。不再散落在用户 home 的 `~/.wenlu`，
 * 也绝不写到桌面。
 *
 * 解析优先级：
 *   1. 环境变量 `WENLU_DATA_DIR`（绝对路径，或相对当前工作目录）——仅供测试/特殊部署覆盖。
 *   2. 默认 `<PROJECT_ROOT>/用户数据`（钉死，正常运行只认这里）。
 *
 * 所有需要落盘用户数据的模块都必须从本模块取根目录，保证单一来源、不漂移、无死角。
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

/** 本文件位于 `<PROJECT_ROOT>/src/config/`，向上两级即项目根。 */
const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 用户数据根目录名（中文，对应项目内「用户数据」分类目录）。 */
export const USER_DATA_DIRNAME = "用户数据";

/**
 * 解析问路运行数据根目录。
 * @returns 数据根目录绝对路径。
 */
export function resolveDataDir(): string {
  const override = process.env.WENLU_DATA_DIR?.trim();
  if (override) return resolvePath(override);
  return resolvePath(PROJECT_ROOT, USER_DATA_DIRNAME);
}

/** 各用户独立数据子目录：`<dataDir>/users/<userId>`。 */
export function resolveUserDataDir(userId: string): string {
  return resolvePath(resolveDataDir(), "users", userId);
}
