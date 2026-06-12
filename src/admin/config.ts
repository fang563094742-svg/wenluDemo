export interface AdminConfig {
  host: string;
  port: number;
  rootPath: string;
  enableAdminJs: boolean;
  basicAuthUser?: string;
  basicAuthPassword?: string;
}

function normalizeRootPath(rootPath: string): string {
  const trimmed = rootPath.trim();
  if (!trimmed || trimmed === "/") {
    return "/internal-admin";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function loadAdminConfig(): AdminConfig {
  return {
    host: process.env.ADMIN_HOST ?? "127.0.0.1",
    port: parseInt(process.env.ADMIN_PORT ?? "3782", 10),
    rootPath: normalizeRootPath(process.env.ADMIN_ROOT_PATH ?? "/internal-admin"),
    enableAdminJs: ["1", "true", "yes", "on"].includes((process.env.ADMIN_ENABLE_ADMINJS ?? "").toLowerCase()),
    basicAuthUser: process.env.ADMIN_BASIC_USER,
    basicAuthPassword: process.env.ADMIN_BASIC_PASSWORD,
  };
}
