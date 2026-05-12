import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const wrapper = readFileSync(new URL("../scripts/mae", import.meta.url), "utf8");

describe("scripts/mae install wrapper", () => {
  test("syncs install-local VERSION during install and update", () => {
    expect(wrapper).toContain("sync_install_version()");
    expect(wrapper).toContain('printf \'%s\\n\' "$version" > "$MAE_INSTALL_DIR/VERSION"');
    expect(wrapper).toContain('sync_install_version "$MAE_REPO_DIR"');
    expect(wrapper).toContain('sync_install_version "$root"');
  });

  test("offers qmd setup for indexed repo search", () => {
    expect(wrapper).toContain("mae setup qmd [--name <collection>] [--embed]");
    expect(wrapper).toContain("qmd collection add \"$root\" --name \"$collection\"");
    expect(wrapper).toContain("qmd embed");
  });
});
