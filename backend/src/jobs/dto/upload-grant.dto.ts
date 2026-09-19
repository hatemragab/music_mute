import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';

export class UploadGrantDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID('4')
  requestId!: string;
}
