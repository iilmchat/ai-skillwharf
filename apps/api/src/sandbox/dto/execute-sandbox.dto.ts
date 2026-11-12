import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ExecuteSandboxDto {
  /** Shell-команда, выполняемая в одноразовом изолированном контейнере. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  code: string;
}
