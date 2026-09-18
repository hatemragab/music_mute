import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

export class RenewWorkerLeaseItemDto {
  @Matches(/^[a-f0-9]{24}$/i) jobId!: string;
  @IsUUID('4') attemptId!: string;
  @IsUUID('4') workerId!: string;
}

export class RenewWorkerLeasesDto {
  @IsUUID('4') requestId!: string;
  @IsUUID('4') sessionId!: string;
  @IsUUID('4') incarnation!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => RenewWorkerLeaseItemDto)
  leases!: RenewWorkerLeaseItemDto[];
}
