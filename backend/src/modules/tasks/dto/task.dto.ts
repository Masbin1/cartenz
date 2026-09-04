import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { AGENT_TASK_KINDS } from '../../../core/enums';

export class CreateTaskDto {
  @IsString()
  @IsNotEmpty({ message: 'A prompt is required' })
  @MinLength(10, { message: 'Describe the change in at least 10 characters' })
  @MaxLength(8000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  prompt!: string;

  /**
   * Which product shape this task is (ADR-029). Omitted, the service defaults to
   * `change`; a `chat` task answers a question in natural language instead of
   * producing a reviewed change.
   */
  @IsOptional()
  @IsIn(AGENT_TASK_KINDS, { message: `kind must be one of: ${AGENT_TASK_KINDS.join(', ')}` })
  kind?: 'change' | 'chat';

  /**
   * Existing session to attach the task to. Omitted for the first task, which
   * opens a session.
   */
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  /**
   * The environment to work against (ADR-021). Omitted, the project's default
   * target is used - which is never a production environment.
   */
  @IsOptional()
  @IsUUID()
  environmentId?: string;
}

export class CancelTaskDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
