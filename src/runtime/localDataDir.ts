import { resolve as resolvePath } from "node:path";

const DEFAULT_LOCAL_DATA_DIR = ".wenlu-local";

export function getWenluDataDir(): string {
  const configured = process.env.WENLU_DATA_DIR?.trim();
  return configured ? resolvePath(configured) : resolvePath(process.cwd(), DEFAULT_LOCAL_DATA_DIR);
}

export function resolveWenluDataPath(...segments: string[]): string {
  return resolvePath(getWenluDataDir(), ...segments);
}
