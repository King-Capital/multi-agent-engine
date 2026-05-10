/** Extract the value following a named flag from an args array. */
export function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

/** Return only positional args, stripping all --flag pairs. */
export function stripFlags(args: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (arg.includes("=")) { i++; } else { i += 2; }
    } else {
      result.push(arg);
      i++;
    }
  }
  return result;
}

/** Convert a name to a URL/filesystem-safe lowercase slug. Throws if empty. */
export function slugify(name: string): string {
  const slug = name.normalize("NFC").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Invalid name "${name}": produces empty slug`);
  return slug;
}
