export function sha256Sri(checksum: string): string {
  if (!/^[a-f0-9]{64}$/u.test(checksum)) throw new Error("Expected a lowercase SHA-256 checksum");
  return `sha256-${Buffer.from(checksum, "hex").toString("base64")}`;
}

export function nixRecipeWithTarballHash(recipe: string, checksum: string): string {
  const pattern = /hash = "sha256-[A-Za-z0-9+/=]+";/gu;
  const matches = recipe.match(pattern);
  if (matches?.length !== 1) throw new Error("Nix recipe must contain exactly one SHA-256 SRI hash");
  return recipe.replace(pattern, `hash = "${sha256Sri(checksum)}";`);
}
