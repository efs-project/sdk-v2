// SPDX-License-Identifier: MIT
// The file stream as a web ReadableStream: pull-based (one window per pull, so backpressure holds), verified chunks
// only, and cancel() aborts the requests in flight. Works in pages, workers, and any runtime with web streams.
import type { Efs } from "../client.js";
import type { OpenedFile } from "../files/bytes.js";
import { fileChunks, type StreamOpts } from "../files/stream.js";

/**
 * Stream an opened file's verified bytes. A stream that cannot continue errors with EfsFault("STREAM_FAILED")
 * (details: grade, reason, emitted). The stream is transferable to a worker; it is not clonable.
 */
export function streamFile(
  efs: Efs,
  file: OpenedFile,
  o: StreamOpts = {},
): ReadableStream<Uint8Array> {
  const chunks = fileChunks(efs, file, o);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const r = await chunks.next();
          if (r.done) controller.close();
          else controller.enqueue(r.value);
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel() {
        await chunks.return();
      },
    },
    { highWaterMark: 1 },
  );
}
