/**
 * The apps offered when a project is created on Odoo Online, mirroring the
 * checkout on odoo.com/trial so the checklist Cartenz shows names the same
 * choices the operator will tick there. Technical names are the Odoo module
 * names the trial installs; the label is what odoo.com calls the app.
 *
 * This is a static list on purpose. odoo.com publishes no catalog endpoint for
 * it and the set changes rarely; a live fetch would add a network dependency to
 * a form for no accuracy gain.
 */
export interface OdooOnlineApp {
  technicalName: string;
  label: string;
  category: string;
}

export const ODOO_ONLINE_APPS: readonly OdooOnlineApp[] = [
  { technicalName: 'website', label: 'Website', category: 'Website' },
  { technicalName: 'website_sale', label: 'eCommerce', category: 'Website' },
  { technicalName: 'website_blog', label: 'Blog', category: 'Website' },
  { technicalName: 'website_forum', label: 'Forum', category: 'Website' },
  { technicalName: 'website_slides', label: 'eLearning', category: 'Website' },
  { technicalName: 'website_event', label: 'Events', category: 'Website' },

  { technicalName: 'crm', label: 'CRM', category: 'Sales' },
  { technicalName: 'sale_management', label: 'Sales', category: 'Sales' },
  { technicalName: 'point_of_sale', label: 'Point of Sale', category: 'Sales' },
  { technicalName: 'pos_restaurant', label: 'Restaurant', category: 'Sales' },
  { technicalName: 'sale_subscription', label: 'Subscriptions', category: 'Sales' },
  { technicalName: 'sale_renting', label: 'Rental', category: 'Sales' },

  { technicalName: 'account', label: 'Invoicing', category: 'Finance' },
  { technicalName: 'accountant', label: 'Accounting', category: 'Finance' },
  { technicalName: 'hr_expense', label: 'Expenses', category: 'Finance' },
  { technicalName: 'sign', label: 'Sign', category: 'Finance' },
  { technicalName: 'equity', label: 'Equity', category: 'Finance' },
  { technicalName: 'esg', label: 'ESG', category: 'Finance' },

  { technicalName: 'project', label: 'Project', category: 'Services' },
  { technicalName: 'timesheet_grid', label: 'Timesheets', category: 'Services' },
  { technicalName: 'planning_field_service', label: 'Field Service', category: 'Services' },
  { technicalName: 'helpdesk', label: 'Helpdesk', category: 'Services' },
  { technicalName: 'appointment', label: 'Appointments', category: 'Services' },
  { technicalName: 'planning', label: 'Planning', category: 'Services' },

  { technicalName: 'documents', label: 'Documents', category: 'Productivity' },
  { technicalName: 'approvals', label: 'Approvals', category: 'Productivity' },
  { technicalName: 'knowledge', label: 'Knowledge', category: 'Productivity' },

  { technicalName: 'stock', label: 'Inventory', category: 'Supply Chain' },
  { technicalName: 'mrp', label: 'Manufacturing', category: 'Supply Chain' },
  { technicalName: 'purchase', label: 'Purchase', category: 'Supply Chain' },
  { technicalName: 'maintenance', label: 'Maintenance', category: 'Supply Chain' },
  { technicalName: 'quality_control', label: 'Quality', category: 'Supply Chain' },
  { technicalName: 'repair', label: 'Repair', category: 'Supply Chain' },

  { technicalName: 'mass_mailing', label: 'Email Marketing', category: 'Marketing' },
  { technicalName: 'mass_mailing_sms', label: 'SMS Marketing', category: 'Marketing' },
  { technicalName: 'survey', label: 'Survey', category: 'Marketing' },
  { technicalName: 'social', label: 'Social Marketing', category: 'Marketing' },

  { technicalName: 'hr', label: 'Employees', category: 'Human Resources' },
  { technicalName: 'hr_attendance', label: 'Attendances', category: 'Human Resources' },
  { technicalName: 'hr_recruitment', label: 'Recruitment', category: 'Human Resources' },
  { technicalName: 'hr_holidays', label: 'Time Off', category: 'Human Resources' },
  { technicalName: 'hr_appraisal', label: 'Appraisals', category: 'Human Resources' },
  { technicalName: 'fleet', label: 'Fleet', category: 'Human Resources' },
  { technicalName: 'hr_payroll', label: 'Payroll', category: 'Human Resources' },

  { technicalName: 'web_studio', label: 'Studio', category: 'Customizations' },
];

/** Where the operator creates the database the project will connect to. */
export const ODOO_TRIAL_SIGNUP_URL = 'https://www.odoo.com/trial';

/**
 * The odoo.com trial link, with the chosen apps pre-ticked.
 *
 * Odoo's own trial page reads `selected_app` (colon-separated technical names)
 * from the query string — that is how its "Odoo Sign" upsell opens the form
 * with one app already chosen. Carrying the apps a person picked here means
 * they do not tick the same boxes twice.
 *
 * `company_name` is read the same way (verified 2026-10-13); the form derives
 * the subdomain from it. Other fields (email, db_name) are not pre-filled.
 * The form cannot be posted from here at all:
 * it is submitted with a `grc3_token` minted by reCAPTCHA v3 in the browser, so
 * only a real browser on odoo.com can complete the signup.
 */
export function trialSignupUrl(apps: readonly string[], companyName = ''): string {
  const query = new URLSearchParams();
  if (apps.length > 0) query.set('selected_app', apps.join(':'));
  if (companyName.trim()) query.set('company_name', companyName.trim());
  const qs = query.toString();
  return qs ? `${ODOO_TRIAL_SIGNUP_URL}?${qs}` : ODOO_TRIAL_SIGNUP_URL;
}

/** Languages offered on odoo.com/trial (the codes its `lang` select uses, copied 2026-10-13). */
export const ODOO_ONLINE_LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'ar_001', name: 'العربية' },
  { code: 'ca_ES', name: 'Català' },
  { code: 'cs_CZ', name: 'Čeština' },
  { code: 'da_DK', name: 'Dansk' },
  { code: 'de_DE', name: 'Deutsch' },
  { code: 'en_US', name: 'English' },
  { code: 'es_ES', name: 'Español' },
  { code: 'es_419', name: 'Español (América Latina)' },
  { code: 'et_EE', name: 'Eesti keel' },
  { code: 'fi_FI', name: 'Suomi' },
  { code: 'fr_FR', name: 'Français' },
  { code: 'he_IL', name: 'עברית' },
  { code: 'id_ID', name: 'Bahasa Indonesia' },
  { code: 'it_IT', name: 'Italiano' },
  { code: 'ja_JP', name: '日本語' },
  { code: 'ko_KR', name: '한국어' },
  { code: 'nl_NL', name: 'Nederlands' },
  { code: 'pl_PL', name: 'Polski' },
  { code: 'pt_BR', name: 'Português (BR)' },
  { code: 'ru_RU', name: 'Русский' },
  { code: 'ro_RO', name: 'română' },
  { code: 'sl_SI', name: 'slovenščina' },
  { code: 'sv_SE', name: 'Svenska' },
  { code: 'th_TH', name: 'ภาษาไทย' },
  { code: 'tr_TR', name: 'Türkçe' },
  { code: 'uk_UA', name: 'українська' },
  { code: 'vi_VN', name: 'Tiếng Việt' },
  { code: 'zh_CN', name: '简体中文' },
  { code: 'zh_TW', name: '繁體中文' },
];

/** odoo.com/trial's "Company size" choices. */
export const ODOO_ONLINE_COMPANY_SIZES: readonly { code: string; name: string }[] = [
  { code: '1-5', name: '1 - 5 employees' },
  { code: '5-20', name: '5 - 20 employees' },
  { code: '20-50', name: '20 - 50 employees' },
  { code: '50-250', name: '50 - 250 employees' },
  { code: '250-over', name: '> 250 employees' },
];

/** odoo.com/trial's "Primary Interest" choices (its `plan` field). */
export const ODOO_ONLINE_PLANS: readonly { code: string; name: string }[] = [
  { code: 'plan_to_use', name: 'Use it in my company' },
  { code: 'plan_to_sell', name: 'Offer Odoo services to other companies' },
  { code: 'plan_to_test_student', name: 'I am a student' },
  { code: 'plan_to_test_teacher', name: 'I am a teacher' },
];

/** odoo.com/trial's own rule for a database name (DB_NAME_REGEX in its signup JS). */
export const ODOO_ONLINE_SUBDOMAIN = /^[a-z0-9][a-z0-9-]{2,48}[a-z0-9]$/;

/**
 * A bookmarklet that fills the odoo.com/trial form from a signup plan.
 *
 * odoo.com reads only `selected_app` and `company_name` from the URL, and its
 * form cannot be submitted from Cartenz (reCAPTCHA v3 mints `grc3_token` only on
 * odoo.com, and a server-side submit is refused as "Trial Refused" — verified
 * 2026-10-13). So the rest is filled in the operator's own browser: run on the
 * trial page, this sets each field and fires the events odoo.com listens to (its
 * company name drives the suggested domain, its domain field runs the
 * availability check). The operator still presses Start Now.
 *
 * ponytail: selectors mirror odoo.com's markup as of 2026-10-13; if they rename
 * a field, that field is silently left for the operator to type.
 */
export function trialFillBookmarklet(signup: {
  companyName: string;
  adminEmail: string;
  subdomain: string;
  countryCode: string;
  fullName?: string;
  phone?: string;
  lang?: string;
  companySize?: string;
  plan?: string;
}): string {
  const values = {
    username: signup.fullName ?? '',
    company_name: signup.companyName,
    email: signup.adminEmail,
    phone: signup.phone ?? '',
    lang: signup.lang ?? '',
    company_size: signup.companySize ?? '',
    plan: signup.plan ?? '',
    country: signup.countryCode,
    db_name: signup.subdomain,
  };
  const script = `(()=>{const v=${JSON.stringify(values)};const f=document.querySelector('.oe_start_trial_form');if(!f){alert('Open odoo.com/trial and press Continue first.');return}const set=(n,x)=>{const e=f.querySelector('[name="'+n+'"]');if(!e||!x)return;e.value=x;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true}))};['username','company_name','email','phone','lang','company_size','plan'].forEach(n=>set(n,v[n]));const c=f.querySelector('select[name="country_id"] option[data-code="'+v.country+'"]');if(c)set('country_id',c.value);setTimeout(()=>{document.querySelector('#edit-db-name')?.click();set('db_name',v.db_name)},1500)})()`;
  return `javascript:${encodeURIComponent(script)}`;
}

/**
 * The address an Odoo Online database answers on. The subdomain is also the
 * database name (Odoo Online derives one from the other), which is why the same
 * string serves as both in the connection the operator adds later.
 */
export function odooOnlineInstanceUrl(subdomain: string): string {
  return `https://${subdomain}.odoo.com`;
}

/**
 * A candidate subdomain from a project name: lowercase, alphanumerics and single
 * hyphens, trimmed to the length odoo.com accepts and neither starting nor
 * ending with a hyphen. Offered as a starting point the operator can edit, not
 * enforced — odoo.com decides what is actually available.
 */
export function suggestSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** Human-readable label for a technical app name, for the project checklist. */
export function appLabel(technicalName: string): string {
  return ODOO_ONLINE_APPS.find((app) => app.technicalName === technicalName)?.label ?? technicalName;
}

/** The apps grouped by category, in the order they first appear, for the picker. */
export function odooOnlineAppGroups(): { category: string; apps: OdooOnlineApp[] }[] {
  const groups: { category: string; apps: OdooOnlineApp[] }[] = [];
  for (const app of ODOO_ONLINE_APPS) {
    const group = groups.find((entry) => entry.category === app.category);
    if (group) group.apps.push(app);
    else groups.push({ category: app.category, apps: [app] });
  }
  return groups;
}

/** The countries on odoo.com/trial, in its order (copied 2026-10-13), keyed by ISO 3166-1 alpha-2. */
export const ODOO_ONLINE_COUNTRIES: readonly { code: string; name: string }[] = [
  { code: 'AF', name: 'Afghanistan' },
  { code: 'AL', name: 'Albania' },
  { code: 'DZ', name: 'Algeria' },
  { code: 'AS', name: 'American Samoa' },
  { code: 'AD', name: 'Andorra' },
  { code: 'AO', name: 'Angola' },
  { code: 'AI', name: 'Anguilla' },
  { code: 'AQ', name: 'Antarctica' },
  { code: 'AG', name: 'Antigua and Barbuda' },
  { code: 'AR', name: 'Argentina' },
  { code: 'AM', name: 'Armenia' },
  { code: 'AW', name: 'Aruba' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' },
  { code: 'AZ', name: 'Azerbaijan' },
  { code: 'BS', name: 'Bahamas' },
  { code: 'BH', name: 'Bahrain' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'BB', name: 'Barbados' },
  { code: 'BY', name: 'Belarus' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BZ', name: 'Belize' },
  { code: 'BJ', name: 'Benin' },
  { code: 'BM', name: 'Bermuda' },
  { code: 'BT', name: 'Bhutan' },
  { code: 'BO', name: 'Bolivia' },
  { code: 'BQ', name: 'Bonaire, Sint Eustatius and Saba' },
  { code: 'BA', name: 'Bosnia and Herzegovina' },
  { code: 'BW', name: 'Botswana' },
  { code: 'BV', name: 'Bouvet Island' },
  { code: 'BR', name: 'Brazil' },
  { code: 'IO', name: 'British Indian Ocean Territory' },
  { code: 'BN', name: 'Brunei Darussalam' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'BF', name: 'Burkina Faso' },
  { code: 'BI', name: 'Burundi' },
  { code: 'KH', name: 'Cambodia' },
  { code: 'CM', name: 'Cameroon' },
  { code: 'CA', name: 'Canada' },
  { code: 'CV', name: 'Cape Verde' },
  { code: 'KY', name: 'Cayman Islands' },
  { code: 'CF', name: 'Central African Republic' },
  { code: 'TD', name: 'Chad' },
  { code: 'CL', name: 'Chile' },
  { code: 'CN', name: 'China' },
  { code: 'CX', name: 'Christmas Island' },
  { code: 'CC', name: 'Cocos (Keeling) Islands' },
  { code: 'CO', name: 'Colombia' },
  { code: 'KM', name: 'Comoros' },
  { code: 'CG', name: 'Congo' },
  { code: 'CK', name: 'Cook Islands' },
  { code: 'CR', name: 'Costa Rica' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CU', name: 'Cuba' },
  { code: 'CW', name: 'Curaçao' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czech Republic' },
  { code: 'CI', name: "Côte d'Ivoire" },
  { code: 'CD', name: 'Democratic Republic of the Congo' },
  { code: 'DK', name: 'Denmark' },
  { code: 'DJ', name: 'Djibouti' },
  { code: 'DM', name: 'Dominica' },
  { code: 'DO', name: 'Dominican Republic' },
  { code: 'TP', name: 'East Timor' },
  { code: 'EC', name: 'Ecuador' },
  { code: 'EG', name: 'Egypt' },
  { code: 'SV', name: 'El Salvador' },
  { code: 'GQ', name: 'Equatorial Guinea' },
  { code: 'ER', name: 'Eritrea' },
  { code: 'EE', name: 'Estonia' },
  { code: 'SZ', name: 'Eswatini' },
  { code: 'ET', name: 'Ethiopia' },
  { code: 'FK', name: 'Falkland Islands' },
  { code: 'FO', name: 'Faroe Islands' },
  { code: 'FJ', name: 'Fiji' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'GF', name: 'French Guiana' },
  { code: 'PF', name: 'French Polynesia' },
  { code: 'TF', name: 'French Southern Territories' },
  { code: 'GA', name: 'Gabon' },
  { code: 'GM', name: 'Gambia' },
  { code: 'GE', name: 'Georgia' },
  { code: 'DE', name: 'Germany' },
  { code: 'GH', name: 'Ghana' },
  { code: 'GI', name: 'Gibraltar' },
  { code: 'GR', name: 'Greece' },
  { code: 'GL', name: 'Greenland' },
  { code: 'GD', name: 'Grenada' },
  { code: 'GP', name: 'Guadeloupe' },
  { code: 'GU', name: 'Guam' },
  { code: 'GT', name: 'Guatemala' },
  { code: 'GG', name: 'Guernsey' },
  { code: 'GN', name: 'Guinea' },
  { code: 'GW', name: 'Guinea Bissau' },
  { code: 'GY', name: 'Guyana' },
  { code: 'HT', name: 'Haiti' },
  { code: 'HM', name: 'Heard Island and McDonald Islands' },
  { code: 'VA', name: 'Holy See (Vatican City State)' },
  { code: 'HN', name: 'Honduras' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IS', name: 'Iceland' },
  { code: 'IN', name: 'India' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'IR', name: 'Iran' },
  { code: 'IQ', name: 'Iraq' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IM', name: 'Isle of Man' },
  { code: 'IL', name: 'Israel' },
  { code: 'IT', name: 'Italy' },
  { code: 'JM', name: 'Jamaica' },
  { code: 'JP', name: 'Japan' },
  { code: 'JE', name: 'Jersey' },
  { code: 'JO', name: 'Jordan' },
  { code: 'KZ', name: 'Kazakhstan' },
  { code: 'KE', name: 'Kenya' },
  { code: 'KI', name: 'Kiribati' },
  { code: 'XK', name: 'Kosovo' },
  { code: 'KW', name: 'Kuwait' },
  { code: 'KG', name: 'Kyrgyzstan' },
  { code: 'LA', name: 'Laos' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LB', name: 'Lebanon' },
  { code: 'LS', name: 'Lesotho' },
  { code: 'LR', name: 'Liberia' },
  { code: 'LY', name: 'Libya' },
  { code: 'LI', name: 'Liechtenstein' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MO', name: 'Macau' },
  { code: 'MG', name: 'Madagascar' },
  { code: 'MW', name: 'Malawi' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'MV', name: 'Maldives' },
  { code: 'ML', name: 'Mali' },
  { code: 'MT', name: 'Malta' },
  { code: 'MH', name: 'Marshall Islands' },
  { code: 'MQ', name: 'Martinique' },
  { code: 'MR', name: 'Mauritania' },
  { code: 'MU', name: 'Mauritius' },
  { code: 'YT', name: 'Mayotte' },
  { code: 'MX', name: 'Mexico' },
  { code: 'FM', name: 'Micronesia' },
  { code: 'MC', name: 'Monaco' },
  { code: 'MN', name: 'Mongolia' },
  { code: 'ME', name: 'Montenegro' },
  { code: 'MS', name: 'Montserrat' },
  { code: 'MA', name: 'Morocco' },
  { code: 'MZ', name: 'Mozambique' },
  { code: 'MM', name: 'Myanmar' },
  { code: 'NA', name: 'Namibia' },
  { code: 'NR', name: 'Nauru' },
  { code: 'NP', name: 'Nepal' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'AN', name: 'Netherlands Antilles' },
  { code: 'NT', name: 'Neutral Zone' },
  { code: 'NC', name: 'New Caledonia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'NI', name: 'Nicaragua' },
  { code: 'NE', name: 'Niger' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'NU', name: 'Niue' },
  { code: 'NF', name: 'Norfolk Island' },
  { code: 'KP', name: 'North Korea' },
  { code: 'MK', name: 'North Macedonia' },
  { code: 'XI', name: 'Northern Ireland' },
  { code: 'MP', name: 'Northern Mariana Islands' },
  { code: 'NO', name: 'Norway' },
  { code: 'OM', name: 'Oman' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'PW', name: 'Palau' },
  { code: 'PA', name: 'Panama' },
  { code: 'PG', name: 'Papua New Guinea' },
  { code: 'PY', name: 'Paraguay' },
  { code: 'PE', name: 'Peru' },
  { code: 'PH', name: 'Philippines' },
  { code: 'PN', name: 'Pitcairn Islands' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'QA', name: 'Qatar' },
  { code: 'MD', name: 'Republic of Moldova' },
  { code: 'RO', name: 'Romania' },
  { code: 'RU', name: 'Russian Federation' },
  { code: 'RW', name: 'Rwanda' },
  { code: 'RE', name: 'Réunion' },
  { code: 'GS', name: 'S. Georgia & S. Sandwich Isls.' },
  { code: 'BL', name: 'Saint Barthélémy' },
  { code: 'SH', name: 'Saint Helena, Ascension and Tristan da Cunha' },
  { code: 'KN', name: 'Saint Kitts and Nevis' },
  { code: 'LC', name: 'Saint Lucia' },
  { code: 'MF', name: 'Saint Martin (French part)' },
  { code: 'PM', name: 'Saint Pierre and Miquelon' },
  { code: 'VC', name: 'Saint Vincent and the Grenadines' },
  { code: 'WS', name: 'Samoa' },
  { code: 'SM', name: 'San Marino' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'SN', name: 'Senegal' },
  { code: 'RS', name: 'Serbia' },
  { code: 'SC', name: 'Seychelles' },
  { code: 'SL', name: 'Sierra Leone' },
  { code: 'SG', name: 'Singapore' },
  { code: 'SX', name: 'Sint Maarten (Dutch part)' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'SB', name: 'Solomon Islands' },
  { code: 'SO', name: 'Somalia' },
  { code: 'XS', name: 'Somaliland' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'KR', name: 'South Korea' },
  { code: 'SS', name: 'South Sudan' },
  { code: 'ES', name: 'Spain' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'PS', name: 'State of Palestine' },
  { code: 'SD', name: 'Sudan' },
  { code: 'SR', name: 'Suriname' },
  { code: 'SJ', name: 'Svalbard and Jan Mayen Islands' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'SY', name: 'Syria' },
  { code: 'ST', name: 'São Tomé and Príncipe' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'TJ', name: 'Tajikistan' },
  { code: 'TZ', name: 'Tanzania' },
  { code: 'TH', name: 'Thailand' },
  { code: 'TL', name: 'Timor-Leste' },
  { code: 'TG', name: 'Togo' },
  { code: 'TK', name: 'Tokelau' },
  { code: 'TO', name: 'Tonga' },
  { code: 'TT', name: 'Trinidad and Tobago' },
  { code: 'TN', name: 'Tunisia' },
  { code: 'TM', name: 'Turkmenistan' },
  { code: 'TC', name: 'Turks and Caicos Islands' },
  { code: 'TV', name: 'Tuvalu' },
  { code: 'TR', name: 'Türkiye' },
  { code: 'UM', name: 'USA Minor Outlying Islands' },
  { code: 'UG', name: 'Uganda' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'UY', name: 'Uruguay' },
  { code: 'UZ', name: 'Uzbekistan' },
  { code: 'VU', name: 'Vanuatu' },
  { code: 'VE', name: 'Venezuela' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'VG', name: 'Virgin Islands (British)' },
  { code: 'VI', name: 'Virgin Islands (USA)' },
  { code: 'WF', name: 'Wallis and Futuna' },
  { code: 'EH', name: 'Western Sahara' },
  { code: 'YE', name: 'Yemen' },
  { code: 'ZM', name: 'Zambia' },
  { code: 'ZW', name: 'Zimbabwe' },
  { code: 'AX', name: 'Åland Islands' },
];
