import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class InstallSkillDto {
  /** Полный текст файла SKILL.md (YAML frontmatter + Markdown body). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200_000)
  fileContent: string;
}
