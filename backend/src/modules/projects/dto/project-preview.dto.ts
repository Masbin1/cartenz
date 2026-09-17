import { IsUUID } from 'class-validator';

/**
 * A request to build an ephemeral preview for one task's draft (ADR-052).
 *
 * The task is named explicitly: the preview is per draft, and a project may hold
 * many tasks. The task must belong to the project the route is scoped to.
 */
export class StartPreviewDto {
  @IsUUID('4', { message: 'A task id is required' })
  taskId!: string;
}
