import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AUDIO_TYPES, type InputDeclaration } from '../jobs/job.types.js';
import { importError } from './import-errors.js';

const execute = promisify(execFile);

export function inspectProbe(
  value: unknown,
  maxDuration: number,
): Pick<InputDeclaration, 'durationSeconds' | 'extension' | 'contentType'> {
  const data = value as {
    streams?: { codec_type?: string; codec_name?: string; duration?: string }[];
    format?: { duration?: string; format_name?: string };
  } | null;
  if (
    !data ||
    !Array.isArray(data.streams) ||
    data.streams.length !== 1 ||
    data.streams[0]?.codec_type !== 'audio'
  )
    throw importError('IMPORT_INVALID_AUDIO');
  const stream = data.streams[0];
  const durationSeconds = Number(data.format?.duration ?? stream.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw importError('IMPORT_INVALID_AUDIO');
  if (durationSeconds > Math.min(maxDuration, 1200))
    throw importError('IMPORT_TOO_LONG', Math.min(maxDuration, 1200));
  const formats = data.format?.format_name?.split(',') ?? [];
  const codec = stream.codec_name;
  let extension: keyof typeof AUDIO_TYPES;
  if (formats.includes('mp3') && codec === 'mp3') extension = 'mp3';
  else if (formats.includes('mov') && ['aac', 'alac'].includes(codec ?? ''))
    extension = 'm4a';
  else if (formats.includes('webm') && ['opus', 'vorbis'].includes(codec ?? ''))
    extension = 'webm';
  else if (formats.includes('ogg') && ['opus', 'vorbis'].includes(codec ?? ''))
    extension = codec === 'opus' ? 'opus' : 'ogg';
  else if (formats.includes('aac') && codec === 'aac') extension = 'aac';
  else throw importError('IMPORT_INVALID_AUDIO');
  return { durationSeconds, extension, contentType: AUDIO_TYPES[extension] };
}

export async function probeImport(
  path: string,
  maxDuration: number,
  signal: AbortSignal,
  executable = '/usr/bin/ffprobe',
) {
  let stdout: string;
  try {
    ({ stdout } = await execute(
      executable,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mov,mp3,matroska,ogg,aac',
        '-show_entries',
        'format=duration,format_name:stream=codec_type,codec_name,duration',
        '-of',
        'json',
        path,
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024, signal, killSignal: 'SIGKILL' },
    ));
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'EACCES'].includes(String(error.code)))
    )
      throw importError('IMPORT_DEPENDENCY_FAILED');
    throw importError('IMPORT_INVALID_AUDIO');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw importError('IMPORT_INVALID_AUDIO');
  }
  return inspectProbe(parsed, maxDuration);
}
