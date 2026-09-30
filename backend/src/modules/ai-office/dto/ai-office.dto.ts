import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query for the activity feed.
 *
 * Keyset paging rather than offset: `before` is the `created_at` of the last
 * row the caller already holds. An offset would skip or repeat rows as new
 * actions arrive, which is guaranteed here because tasks are running.
 */
export class ActivityQueryDto {
  /** ISO 8601 timestamp; return actions strictly older than this. */
  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
