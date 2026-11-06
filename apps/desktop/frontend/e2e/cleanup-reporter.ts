import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import type { FullResult, Reporter } from '@playwright/test/reporter';

type CleanupReporterOptions = {
  artifactDir?: string;
};

class KurloCleanupReporter implements Reporter {
  private artifactDir: string;
  private passed = false;
  private ranTests = false;

  constructor(options: CleanupReporterOptions = {}) {
    this.artifactDir = options.artifactDir ?? '';
  }

  onTestBegin() {
    this.ranTests = true;
  }

  onEnd(result: FullResult) {
    this.passed = result.status === 'passed';
  }

  onExit() {
    if (process.env.CI || process.env.KURLO_E2E_KEEP_ARTIFACTS === '1' || process.env.KURLO_E2E_HTML_REPORT === '1') return;
    if (!this.ranTests || !this.passed || !this.isSafeArtifactDir()) return;

    rmSync(this.artifactDir, { recursive: true, force: true });
  }

  private isSafeArtifactDir() {
    const artifactDir = resolve(this.artifactDir);
    const tempRoot = resolve(tmpdir());
    return artifactDir.startsWith(`${tempRoot}${sep}`) && basename(artifactDir).startsWith('kurlo-playwright-artifacts');
  }
}

export default KurloCleanupReporter;
