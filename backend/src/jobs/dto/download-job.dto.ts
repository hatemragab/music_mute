import { IsIn, IsUUID } from 'class-validator';

export class DownloadJobDto {
  @IsIn(['input', 'output']) artifact!: 'input' | 'output';
  @IsUUID('4') requestId!: string;
}
