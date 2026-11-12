import { IsBoolean } from 'class-validator';

export class ToggleSkillDto {
  /** Включён ли навык в каталоге. */
  @IsBoolean()
  isEnabled: boolean;
}
