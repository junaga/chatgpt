import assert from "node:assert/strict";
import test from "node:test";
import { nixRecipeWithTarballHash, sha256Sri } from "../src/package-recipes.ts";

test("Nix release recipes receive the exact generic-tarball SRI hash", () => {
  const checksum = "00".repeat(32);
  assert.equal(sha256Sri(checksum), "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  assert.equal(
    nixRecipeWithTarballHash('src = { hash = "sha256-old="; };\n', checksum),
    'src = { hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; };\n',
  );
  assert.throws(() => nixRecipeWithTarballHash("no hash\n", checksum), /exactly one/);
});
