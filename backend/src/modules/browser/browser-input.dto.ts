import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/** One input a person sends to their browser session (ADR-087). */
export class BrowserInputDto {
  @IsIn(['click', 'scroll', 'type', 'key', 'navigate', 'back', 'forward', 'reload'])
  type!: 'click' | 'scroll' | 'type' | 'key' | 'navigate' | 'back' | 'forward' | 'reload';

  @IsOptional()
  @IsInt()
  x?: number;

  @IsOptional()
  @IsInt()
  y?: number;

  @IsOptional()
  @IsInt()
  dy?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  text?: string;

  /** A Playwright key name: Enter, Tab, Backspace, ArrowDown, Control+a, ... */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;
}
