import { IsBoolean, IsIn, IsOptional, ValidateIf } from 'class-validator';

export class UnpairWorkerMachineDto {
  @IsOptional() @IsBoolean() force?: boolean;
}

export class GetWorkerUpdateDto {
  @IsIn(['darwin-arm64', 'windows-amd64'])
  platform!: 'darwin-arm64' | 'windows-amd64';

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['windows-user'])
  installationProfile?: 'windows-user';

  @IsBoolean()
  @IsOptional()
  download?: boolean;
}
