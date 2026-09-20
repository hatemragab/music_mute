import {
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ArrayMaxSize,
  ArrayMinSize,
} from 'class-validator';
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from '../protocol/v1/protocol.js';

export class OpenWorkerSessionDto {
  @IsUUID('4') sessionId!: string;
  @IsUUID('4') incarnation!: string;
}

export class RegisterWorkerSlotDto {
  @IsUUID('4') workerId!: string;
  @IsUUID('4') sessionId!: string;
  @IsUUID('4') incarnation!: string;
  @IsString() @Length(1, 128) gpuId!: string;
  @IsInt() @Min(0) @Max(15) slotIndex!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsIn(WORKER_RECIPE_IDS, { each: true })
  recipeIds!: WorkerRecipeId[];
}

export class ClaimWorkerJobDto {
  @IsUUID('4') requestId!: string;
  @IsUUID('4') workerId!: string;
  @IsUUID('4') sessionId!: string;
  @IsUUID('4') incarnation!: string;
  @IsString() @Length(1, 128) gpuId!: string;
  @IsInt() @Min(0) @Max(15) slotIndex!: number;
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  appliedPolicyRevision!: number;
}
