// Replacement for @kohaku-eth/tornado-cash's internal "#worker-loader" subpath
// import (aliased in next.config.ts). The package's own browser loader is a
// .ts source file with a worker URL that is wrong for the dist layout, so
// webpack cannot use it.
//
// Crucially, this does `new Worker(new URL(...))` with a literal specifier so
// webpack recognizes it as a worker entry and recursively bundles the worker
// AND its nested workers (msm-worker, merkle-tree). Passing a pre-built URL
// string instead would skip that and leave the nested workers unbundled.

import { wrap } from "comlink";

export function loadStateManagerWorker(workerUrl?: string | URL) {
  const worker = workerUrl
    ? new Worker(workerUrl, { type: "module" })
    : new Worker(new URL("@kohaku-tc-worker", import.meta.url), {
        type: "module",
      });
  return {
    remote: wrap(worker),
    onError: (handler: (err: unknown) => void) =>
      worker.addEventListener("error", (e) =>
        handler(e.error ?? new Error(e.message))
      ),
  };
}
