import { parseModuleList } from './project-modules.service';

/**
 * `list-installed-modules.sh` prints `psql -tA -F $'\t'` output: one
 * `name<TAB>state` pair per line, no header, no row count footer (that is
 * `-t`), sorted by name. Every diagnostic the script emits goes to stderr, so
 * stdout should always be clean - but a wrong parse here would silently show
 * someone a fabricated module list, which is worse than an empty one.
 */
describe('parseModuleList', () => {
  it('parses a well-formed tab-separated list', () => {
    const stdout = 'base\tinstalled\ndigest\tinstalled\nsale\tinstalled\nstock\tuninstalled\n';
    expect(parseModuleList(stdout)).toEqual([
      { name: 'base', state: 'installed' },
      { name: 'digest', state: 'installed' },
      { name: 'sale', state: 'installed' },
      { name: 'stock', state: 'uninstalled' },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseModuleList('')).toEqual([]);
  });

  it('ignores blank lines', () => {
    const stdout = 'base\tinstalled\n\n\nsale\tinstalled\n';
    expect(parseModuleList(stdout)).toEqual([
      { name: 'base', state: 'installed' },
      { name: 'sale', state: 'installed' },
    ]);
  });

  it('skips a line with the wrong number of fields rather than misreading it', () => {
    const stdout = 'base\tinstalled\nmalformed line with no tab\nsale\ttoo\tmany\tfields\nstock\tinstalled\n';
    expect(parseModuleList(stdout)).toEqual([
      { name: 'base', state: 'installed' },
      { name: 'stock', state: 'installed' },
    ]);
  });

  it('trims trailing whitespace and a trailing newline', () => {
    expect(parseModuleList('base\tinstalled\n')).toEqual([{ name: 'base', state: 'installed' }]);
    expect(parseModuleList('base\tinstalled')).toEqual([{ name: 'base', state: 'installed' }]);
  });
});
