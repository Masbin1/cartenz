import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class GrantProjectAccessDto {
  @IsUUID('4', { message: 'A user id is required' })
  userId!: string;
}

export class RequestProjectAccessDto {
  /** Optional: asking for a reason as a condition would just produce empty ones. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  reason?: string;
}

export class DecideAccessRequestDto {
  @IsIn(['approved', 'rejected'], {
    message: 'decision must be approved or rejected',
  })
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  note?: string;
}
