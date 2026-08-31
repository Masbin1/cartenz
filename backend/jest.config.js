/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  /**
   * Raised from the 5 s default because two suites are deliberately slow and were
   * flaking under full parallelism, not failing:
   *
   * - password.service.spec.ts runs scrypt, which is meant to be expensive; that
   *   is the point of using it, and it competes with 20 other workers for CPU.
   * - command-runner.spec.ts spawns real git processes.
   *
   * A flaky test on a security assertion is worse than no test, because people
   * learn to re-run it rather than read it. Neither of these tests is about
   * speed, so giving them room is the honest fix.
   */
  testTimeout: 30_000,
  rootDir: 'src',
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/$1',
  },
  coverageDirectory: '../coverage',
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
};
