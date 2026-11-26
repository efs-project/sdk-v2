// SPDX-License-Identifier: MIT
// Which gas-model row a FOLDER BIND is priced at (folderBindRow, src/files/entries.ts), by the writer's head at the
// position (gas/model.json laterRows.rule): a first statement pays a fresh row, a bound entry pointed elsewhere a
// re-bind (bindFolderRebind, no long tier), a masked or released one that bound before a restore (restoreFolder,
// measured placing a new target), and one that never bound (only hidden, perhaps released) bindFolderAfterNo.
import { describe, expect, it } from "vitest";
import { folderBindRow } from "../src/files/entries.ts";

describe("folderBindRow", () => {
  it("UNSET: a fresh row; BOUND: a re-bind; MASKED or RELEASED: a restore, or a yes after a lone hide", () => {
    expect(folderBindRow({ state: 0, targetKind: 0 }, false)).toBe("bindFolderFreshFile");
    expect(folderBindRow({ state: 0, targetKind: 0 }, true)).toBe("bindFolderFreshDirectory");
    expect(folderBindRow({ state: 1, targetKind: 1 }, false)).toBe("bindFolderRebind");
    expect(folderBindRow({ state: 2, targetKind: 2 }, true)).toBe("restoreFolder");
    expect(folderBindRow({ state: 3, targetKind: 1 }, false)).toBe("restoreFolder");
    expect(folderBindRow({ state: 2, targetKind: 0 }, false)).toBe("bindFolderAfterNo"); // a lone hide
    expect(folderBindRow({ state: 3, targetKind: 0 }, true)).toBe("bindFolderAfterNo"); // a hide, then released
    expect(folderBindRow({ state: 9, targetKind: 1 }, false)).toBeUndefined(); // unrecognized: the dearest BIND row
  });
});
