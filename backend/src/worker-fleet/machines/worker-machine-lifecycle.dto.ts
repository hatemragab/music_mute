import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class UnpairWorkerMachineDto {
  @IsOptional() @IsBoolean() force?: boolean;
}

export class GetWorkerUpdateDto {
  @IsIn(['darwin-arm64', 'windows-amd64'])
  platform!: 'darwin-arm64' | 'windows-amd64';

  @IsBoolean()
  @IsOptional()
  download?: boolean;
}
