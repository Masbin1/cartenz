import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { organization } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';

export interface PublicOrganization {
  readonly name: string;
  readonly allowedDomains: string[];
}

/** The part after the last `@`, lower-cased. */
export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lower-cased, `@` and blanks stripped, duplicates dropped; refuses anything not a hostname. */
export function normaliseDomains(input: string[]): string[] {
  const domains = input.map((value) => value.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  const bad = domains.find((domain) => !DOMAIN.test(domain));
  if (bad) throw new BadRequestException(`"${bad}" is not a domain, like linkederp.com.`);
  return [...new Set(domains)];
}

/**
 * The organisation and the email domains that may hold an account (ADR-072
 * addendum 2). An account outside them is refused at registration and at
 * invitation; existing accounts are left alone.
 */
@Injectable()
export class OrganizationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<PublicOrganization> {
    const [row] = await this.database.db.select().from(organization).limit(1);
    return { name: row?.name ?? '', allowedDomains: row?.allowedDomains ?? [] };
  }

  /** Throws unless the address belongs to an allowed domain. */
  async requireAllowedEmail(email: string): Promise<void> {
    const { allowedDomains } = await this.get();
    if (!allowedDomains.includes(emailDomain(email))) {
      throw new ForbiddenException(
        `Accounts for @${emailDomain(email)} are not allowed here. Ask an administrator to add the domain.`,
      );
    }
  }

  async update(
    userId: string | null,
    input: { name?: string; allowedDomains?: string[] },
  ): Promise<PublicOrganization> {
    const current = await this.get();
    const values = {
      name: input.name === undefined ? current.name : input.name.trim(),
      allowedDomains:
        input.allowedDomains === undefined ? current.allowedDomains : normaliseDomains(input.allowedDomains),
      updatedByUserId: userId,
      updatedAt: new Date(),
    };

    const [row] = await this.database.db.select({ id: organization.id }).from(organization).limit(1);
    if (row) {
      await this.database.db.update(organization).set(values);
    } else {
      await this.database.db.insert(organization).values(values);
    }

    await this.audit.record({
      event: AUDIT_EVENTS.ORGANIZATION_UPDATED,
      userId,
      metadata: { name: values.name, allowedDomains: values.allowedDomains },
    });
    return { name: values.name, allowedDomains: values.allowedDomains };
  }
}
