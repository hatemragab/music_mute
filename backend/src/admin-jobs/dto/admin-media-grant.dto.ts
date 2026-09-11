import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class AdminMediaGrantDto {
  @IsIn(['input', 'result'])
  asset!: 'input' | 'result';

  @IsIn(['play', 'download'])
  purpose!: 'play' | 'download';

  @IsUUID('4')
  operationId!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
