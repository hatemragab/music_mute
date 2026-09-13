import { Equals, IsInt, Max, Min, ValidateBy } from 'class-validator';
import { isSha256 } from '../../jobs/job-state.js';
import { WorkerEventDto } from './worker-event.dto.js';

export class WorkerOutputDto extends WorkerEventDto {
  @IsInt() @Min(1) @Max(100_000_000) bytes!: number;
  @ValidateBy({
    name: 'audioDuration',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value > 0 &&
        value <= 1800,
    },
  })
  durationSeconds!: number;
  @ValidateBy({ name: 'sha256', validator: { validate: isSha256 } })
  sha256!: string;
  @Equals('audio/mpeg') contentType!: 'audio/mpeg';
  @Equals(true) playable!: true;
  @Equals(true) voiceOnly!: true;
}
