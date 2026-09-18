export type LogTee = (tag: string | null, msg: string) => void;

const tees: LogTee[] = [];
// a tee that logs (or throws) must not recurse log -> tee -> log
let inTee = false;

/** register a listener on every log line; returns the unsubscribe */
export function addTee(fn: LogTee): () => void {
  tees.push(fn);
  return () => {
    const i = tees.indexOf(fn);
    if (i >= 0) tees.splice(i, 1);
  };
}

export function logTagged(tag: string | null, msg: string): void {
  console.log(`[${new Date().toISOString()}] ${tag === null ? '' : `[${tag}] `}${msg}`);
  if (inTee || tees.length === 0) return;
  inTee = true;
  try {
    for (const t of tees) {
      try {
        t(tag, msg);
      } catch {
        // a broken tee never breaks the log
      }
    }
  } finally {
    inTee = false;
  }
}

export function log(msg: string): void {
  logTagged(null, msg);
}
