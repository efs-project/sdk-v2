// SPDX-License-Identifier: MIT
// Which gas-model row a FOLDER BIND is priced at (folderBindRow, src/files/entries.ts), by the writer's head at the
// position: a first statement pays a fresh row, a bound entry pointed elsewhere a re-bind (bindFolderRebind, no long
// tier), and a masked or released one a restore (restoreFolder, contracts 6d11858). Naming the row keeps such a bind
// off the dearest BIND row, which since the list tiers is a long-tier restore about 25% above a re-bind.
import { describe, expect, it } from "vitest";
import { folderBindRow } from "../src/files/entries.ts";

describe("folderBindRow", () => {
  it("UNSET: a fresh file or directory row; BOUND: a re-bind; MASKED or RELEASED: a restore", () => {
    expect(folderBindRow({ state: 0 }, false)).toBe("bindFolderFreshFile");
    expect(folderBindRow({ state: 0 }, true)).toBe("bindFolderFreshDirectory");
    expect(folderBindRow({ state: 1 }, false)).toBe("bindFolderRebind");
    expect(folderBindRow({ state: 2 }, true)).toBe("restoreFolder");
    expect(folderBindRow({ state: 3 }, false)).toBe("restoreFolder");
    expect(folderBindRow({ state: 9 }, false)).toBeUndefined(); // unrecognized: priced at the dearest BIND row
  });
});
