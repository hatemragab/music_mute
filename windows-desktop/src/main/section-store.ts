import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { SECTIONS, type Section } from "../shared/contracts.js";
/** Presentation state only; no account material or media paths. */
export class SectionStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async read(): Promise<Section> {
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024)
        return "home";
      const value: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (
        value &&
        typeof value === "object" &&
        "section" in value &&
        SECTIONS.includes(value.section as Section)
      )
        return value.section as Section;
    } catch {
      /* Missing/corrupt presentation state falls back without losing data. */
    }
    return "home";
  }
  write(section: Section): Promise<void> {
    if (!SECTIONS.includes(section))
      return Promise.reject(new Error("INVALID_REQUEST"));
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, section }), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.writes = operation;
    return operation;
  }
}
