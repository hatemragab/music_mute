import { Transform } from 'class-transformer';
import { IsString, IsUUID, Matches } from 'class-validator';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
// Match the UTF-16 bounds used by HTML maxlength and Mongo string validators.
export class CreateNotificationDto {
  @IsUUID('4') operationId!: string;
  @Transform(trim) @IsString() @Matches(/^[\s\S]{1,80}$/) title!: string;
  @Transform(trim) @IsString() @Matches(/^[\s\S]{1,500}$/) body!: string;
  @Transform(trim) @IsString() @Matches(/^[\s\S]{1,500}$/) reason!: string;
}
