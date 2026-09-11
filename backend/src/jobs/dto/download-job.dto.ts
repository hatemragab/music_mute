import { IsIn } from 'class-validator';

export class DownloadJobDto {
  @IsIn(['input', 'output']) artifact!: 'input' | 'output';
}
