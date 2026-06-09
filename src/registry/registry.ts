/**
 * 通用可插拔注册表（R17.2 / R17.3）。
 *
 * 三大可插拔点 —— Device_Scanner（按平台 key）、LLM_Provider（按 provider key）、
 * Executor_Tool（按 tool name）—— 共享同一"接口 + 注册表"模式。注册表在启动时
 * 装配（composition root），业务模块只依赖 `Registry<T>` 接口，不依赖具体实现，
 * 从而满足"新增某实现时无需改动调用方接口契约"（R17.3）。
 */

/**
 * 通用注册表契约：以字符串 key 注册/解析实现。
 *
 * @typeParam T 被注册实现的类型（如 Device_Scanner / LLM_Provider / Executor_Tool）。
 */
export interface Registry<T> {
  /**
   * 以 `key` 注册一个实现。重复 key 视为覆盖（后注册者生效），
   * 以便测试或运行期替换实现。
   */
  register(key: string, impl: T): void;

  /**
   * 按 `key` 解析实现。
   * @throws {RegistryError} 当 `key` 未注册时，抛出带描述性信息的错误（R17.3）。
   */
  resolve(key: string): T;

  /** 判断 `key` 是否已注册。 */
  has(key: string): boolean;
}

/** 注册表解析失败时抛出的描述性错误。 */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * `Registry<T>` 的默认内存实现，基于 `Map<string, T>`。
 *
 * @typeParam T 被注册实现的类型。
 */
export class DefaultRegistry<T> implements Registry<T> {
  /** 注册表的可读名称，用于解析失败时构造描述性错误信息。 */
  private readonly label: string;
  private readonly store = new Map<string, T>();

  /**
   * @param label 注册表标识（如 "ScannerRegistry"），仅用于错误信息可读性。
   */
  constructor(label = "Registry") {
    this.label = label;
  }

  register(key: string, impl: T): void {
    this.store.set(key, impl);
  }

  resolve(key: string): T {
    const impl = this.store.get(key);
    if (impl === undefined) {
      const known = this.keys();
      const knownDesc =
        known.length > 0 ? known.map((k) => `"${k}"`).join(", ") : "（无）";
      throw new RegistryError(
        `${this.label}: 未找到 key="${key}" 对应的注册实现。已注册的 key: ${knownDesc}。`,
      );
    }
    return impl;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  /** 返回当前已注册的所有 key（快照），主要用于诊断与错误信息。 */
  keys(): string[] {
    return [...this.store.keys()];
  }
}
