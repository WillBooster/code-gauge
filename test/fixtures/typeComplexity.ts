type Id = string | number;
interface User {
  id: Id;
  name: string;
}
type Result<T> = { ok: true; value: T } | { ok: false };

export function pick<T>(list: T[], index: number): T {
  const found = list[index] as T;
  return found!;
}

export const admin = { id: 1 } satisfies Partial<User>;
