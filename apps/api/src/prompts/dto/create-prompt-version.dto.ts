import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreatePromptVersionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50_000)
  content: string;
}
