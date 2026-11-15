/** A real bounded ZIP containing sanitized JSON only; no media or configuration values. */
import { crc32 } from "../../crc32.js";
export function createFleetDiagnosticArchive(
  data: unknown,
  now = new Date(),
): Buffer {
  const contents: [string, Buffer][] = [
    [
      "manifest.json",
      Buffer.from(
        JSON.stringify({
          version: 1,
          createdAt: now.toISOString(),
          scope: "windows-user-fleet",
          privacy:
            "Sanitized local reports only; excludes credentials, grants, configuration values and media",
          files: ["report.json"],
        }),
      ),
    ],
    ["report.json", Buffer.from(JSON.stringify(data, null, 2))],
  ];
  const body: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0,
    size = 0;
  for (const [filename, bytes] of contents) {
    size += bytes.length;
    if (size > 8 * 1024 ** 2) throw new Error("ADVANCED_RESULT_TOO_LARGE");
    const name = Buffer.from(filename),
      crc = crc32(bytes),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    body.push(header, name, bytes);
    central.push(entry, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(contents.length, 8);
  end.writeUInt16LE(contents.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, directory, end]);
}
