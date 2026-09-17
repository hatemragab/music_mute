import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class AppendInstallationLogsDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  sequenceStart!: number;
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  sequenceEnd!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  lines!: string[];
}

export class AppendRuntimeLogsDto extends AppendInstallationLogsDto {
  @IsUUID('4') sessionId!: string;
  @IsUUID('4') incarnation!: string;
}
