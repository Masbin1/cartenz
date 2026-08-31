import { IsEmail, IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ORGANIZATION_ROLES, type OrganizationRole } from '../../../core/enums';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty({ message: 'An organisation name is required' })
  @MaxLength(200)
  @Transform(trim)
  name!: string;
}

export class AddMemberDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  /**
   * `owner` is accepted so that ownership can be transferred, but the
   * authorisation layer permits only an existing owner to grant it.
   */
  @IsIn(ORGANIZATION_ROLES, {
    message: `role must be one of: ${ORGANIZATION_ROLES.join(', ')}`,
  })
  role!: OrganizationRole;
}

export class UpdateMemberRoleDto {
  @IsIn(ORGANIZATION_ROLES, {
    message: `role must be one of: ${ORGANIZATION_ROLES.join(', ')}`,
  })
  role!: OrganizationRole;
}
