export type QueryValue = string | number | boolean | null | undefined;

export const withQuery = <T extends object>(path: string, values: T) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values) as Array<
    [string, QueryValue]
  >) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
};
