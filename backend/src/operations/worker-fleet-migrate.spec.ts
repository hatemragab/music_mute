import {
  parseWorkerFleetMigrationArgs,
  WorkerFleetMigrationInputError,
} from './worker-fleet-migrate.js';

describe('worker fleet migration CLI parser', () => {
  it('requires exactly one explicit mode', () => {
    expect(parseWorkerFleetMigrationArgs(['--dry-run'])).toEqual({
      apply: false,
    });
    expect(parseWorkerFleetMigrationArgs(['--apply'])).toEqual({ apply: true });
    expect(() => parseWorkerFleetMigrationArgs([])).toThrow(
      WorkerFleetMigrationInputError,
    );
    expect(() =>
      parseWorkerFleetMigrationArgs(['--dry-run', '--apply']),
    ).toThrow(WorkerFleetMigrationInputError);
    expect(() => parseWorkerFleetMigrationArgs(['--force'])).toThrow(
      WorkerFleetMigrationInputError,
    );
  });
});
