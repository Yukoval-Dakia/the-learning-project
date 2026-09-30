import { JsonReporter } from 'vitest/reporters';

export default class DbJsonReporter extends JsonReporter {
  timings = new Map();

  constructor(options = {}) {
    super(options);
  }

  async onTestRunEnd(modules, ...args) {
    for (const module of modules) {
      const diagnostic = module.diagnostic();
      this.timings.set(module.moduleId, {
        prepare_ms: diagnostic.prepareDuration,
        environment_ms: diagnostic.environmentSetupDuration,
        setup_ms: diagnostic.setupDuration,
        import_ms: diagnostic.collectDuration,
        tests_ms: diagnostic.duration,
      });
    }
    await super.onTestRunEnd(modules, ...args);
  }

  async writeReport(json) {
    const report = JSON.parse(json);
    for (const file of report.testResults) {
      const timing = this.timings.get(file.name);
      if (timing) {
        file.db_timing = timing;
        file.duration = Object.values(timing).reduce((total, ms) => total + ms, 0);
      }
    }
    await super.writeReport(JSON.stringify(report));
  }
}
