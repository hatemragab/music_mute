import { IsEmail, IsString, MaxLength } from 'class-validator';

export class PasswordResetDto {
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
