// Zilux2 移植用 shim：folia 只用到 MotionValue 的 get()/set()（见 createLumierePixiRuntime.ts、lumiereAudio.ts）
export class MotionValue<T> {
  private value: T;

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
  }
}
