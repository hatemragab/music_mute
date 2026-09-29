export function extractBooleanFlag(
  arguments_: readonly string[],
  flag: string,
): { present: boolean; remaining: string[] } {
  const count = arguments_.filter((argument) => argument === flag).length;
  if (count > 1) throw new TypeError(`Command flag ${flag} is duplicated`);
  return {
    present: count === 1,
    remaining: arguments_.filter((argument) => argument !== flag),
  };
}

export function parseValueFlags(
  arguments_: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  if (arguments_.length % 2 !== 0)
    throw new TypeError("Command flag is missing a value");
  const result = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]!;
    const value = arguments_[index + 1]!;
    if (!flag.startsWith("--") || !allowed.has(flag.slice(2)))
      throw new TypeError(`Unknown command flag: ${flag}`);
    if (value.length < 1 || value.startsWith("--"))
      throw new TypeError(`Command flag ${flag} has an invalid value`);
    if (result.has(flag.slice(2)))
      throw new TypeError(`Command flag ${flag} is duplicated`);
    result.set(flag.slice(2), value);
  }
  return result;
}

export function exactArguments(
  arguments_: readonly string[],
  allowed: ReadonlySet<string>,
): void {
  if (new Set(arguments_).size !== arguments_.length)
    throw new TypeError("Command arguments contain duplicates");
  if (arguments_.some((argument) => !allowed.has(argument)))
    throw new TypeError("Command contains an unknown argument");
}
