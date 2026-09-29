export function compareWorkerReleaseVersions(
  left: string,
  right: string,
): number {
  const semver =
    /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*)?$/u;
  const leftMatch = semver.exec(left);
  const rightMatch = semver.exec(right);
  if (leftMatch && rightMatch) {
    for (let index = 1; index <= 3; index++) {
      const comparison = compareNumericIdentifier(
        leftMatch[index] ?? "0",
        rightMatch[index] ?? "0",
      );
      if (comparison !== 0) return comparison;
    }
    const leftPre = leftMatch[4];
    const rightPre = rightMatch[4];
    if (leftPre === undefined || rightPre === undefined) {
      if (leftPre === rightPre) return 0;
      return leftPre === undefined ? 1 : -1;
    }
    const leftParts = leftPre.split(/[._-]/u);
    const rightParts = rightPre.split(/[._-]/u);
    for (
      let index = 0;
      index < Math.max(leftParts.length, rightParts.length);
      index++
    ) {
      const leftPart = leftParts[index];
      const rightPart = rightParts[index];
      if (leftPart === undefined || rightPart === undefined)
        return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
      const comparison = comparePrereleaseIdentifier(leftPart, rightPart);
      if (comparison !== 0) return comparison;
    }
    return 0;
  }
  return compareNaturalVersion(left, right);
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return compareNumericIdentifier(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareNumericIdentifier(left: string, right: string): number {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
}

function compareNaturalVersion(left: string, right: string): number {
  const tokenize = (value: string) => value.match(/\d+|\D+/gu) ?? [];
  const leftParts = tokenize(left);
  const rightParts = tokenize(right);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index++
  ) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const comparison =
      /^\d+$/u.test(leftPart) && /^\d+$/u.test(rightPart)
        ? compareNumericIdentifier(leftPart, rightPart)
        : leftPart < rightPart
          ? -1
          : 1;
    if (comparison !== 0) return comparison;
  }
  return 0;
}
