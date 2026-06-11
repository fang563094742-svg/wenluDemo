/**
 * semaphore.ts — 异步 counting semaphore。
 *
 * 用于并发调度器限流：控制同时 in-flight 的工具执行数量。
 * 基于 Promise queue，zero dependency。
 */

export type Release = () => void;

export interface Semaphore {
  acquire(): Promise<Release>;
  readonly available: number;
  readonly waiting: number;
}

export function createSemaphore(permits: number): Semaphore {
  let current = permits;
  const queue: Array<(release: Release) => void> = [];

  function release(): void {
    current++;
    const next = queue.shift();
    if (next) {
      current--;
      next(release);
    }
  }

  function acquire(): Promise<Release> {
    if (current > 0) {
      current--;
      return Promise.resolve(release);
    }
    return new Promise<Release>((resolve) => {
      queue.push(resolve);
    });
  }

  return {
    acquire,
    get available() { return current; },
    get waiting() { return queue.length; },
  };
}
