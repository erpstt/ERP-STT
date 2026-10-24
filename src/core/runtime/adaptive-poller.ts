export type AdaptivePollerOptions = {
  idleMilliseconds?: number;
  activeMilliseconds?: number;
  onError?: (cause: unknown) => void;
};

export function pollMilliseconds(value: unknown, fallback = 30000) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.min(300000, Math.max(5000, Math.trunc(parsed)))
    : fallback;
}

/**
 * Ejecuta una cola sin solapar ciclos. Mientras haya trabajo vuelve a consultar
 * de inmediato; cuando la cola queda vacía reduce la frecuencia de consultas.
 */
export function startAdaptivePoller(
  task: () => Promise<boolean>,
  options: AdaptivePollerOptions = {}
) {
  const idleMilliseconds = Math.max(10, Math.trunc(options.idleMilliseconds ?? 30000));
  const activeMilliseconds = Math.max(10, Math.trunc(options.activeMilliseconds ?? 250));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  };
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    let active = false;
    try {
      active = await task();
    } catch (cause) {
      options.onError?.(cause);
    } finally {
      running = false;
      schedule(active ? activeMilliseconds : idleMilliseconds);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
