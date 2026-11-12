import { IsOptional, IsString } from 'class-validator';

export class ValidateSkillDto {
  /**
   * Полный текст файла SKILL.md (YAML frontmatter + Markdown body).
   * `content` поддержан как короткий алиас.
   */
  @IsOptional()
  @IsString()
  fileContent?: string;

  @IsOptional()
  @IsString()
  content?: string;
}
