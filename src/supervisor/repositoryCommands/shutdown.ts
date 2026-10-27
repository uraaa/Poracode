import { drainRepositoryMutations } from "./scheduling";

/** Stop producers before draining accepted mutations; retain a bounded exit deadline. */
export async function drainSupervisorShutdown(
  disposeRuntime: () => Promise<void>,
  disposeCommands: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    try {
      await disposeRuntime();
    } finally {
      await drainRepositoryMutations();
      await disposeCommands();
    }
  };
  try {
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
