import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const metadata = readFileSync(
  new URL("../action.yml", import.meta.url),
  "utf8",
);

function isolationStep(): string {
  const step = metadata.match(
    /    - name: Install subprocess isolation dependencies\n([\s\S]*?)\n    - name: Pin bun binary for post-steps/,
  )?.[1];
  if (!step) throw new Error("subprocess isolation step not found");
  return step;
}

function isolationScript(): string {
  const script = isolationStep().match(/      run: \|\n([\s\S]*)/)?.[1];
  if (!script) throw new Error("subprocess isolation script not found");
  return script.replace(/^ {8}/gm, "");
}

function writeExecutable(directory: string, name: string, body: string): void {
  const target = join(directory, name);
  writeFileSync(target, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
  chmodSync(target, 0o755);
}

describe("action metadata", () => {
  test("should expose the conclusion output from the run step", () => {
    expect(metadata).toMatch(
      /^  conclusion:\n    description: .+\n    value: \$\{\{ steps\.run\.outputs\.conclusion \}\}$/m,
    );
  });

  test("bounds subprocess isolation setup and fails closed", () => {
    const step = isolationStep();

    expect(step).not.toContain("continue-on-error: true");
    expect(step).toContain("set -euo pipefail");
    expect(step).toContain("command -v bwrap");
    expect(step).toContain("command -v socat");
    expect(step).toContain("timeout --kill-after=10s 60s");
    expect(step).toContain("sudo -n apt-get");
    expect(step).toContain("DPkg::Lock::Timeout=30");
    expect(step).toContain(
      'echo "Subprocess isolation helper $dependency is unavailable" >&2',
    );
  });

  test("skips apt when helpers exist and rejects a false-success install", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-isolation-test-"));
    try {
      const script = isolationScript();
      const marker = join(root, "apt-invoked");
      writeExecutable(root, "bwrap", "exit 0");
      writeExecutable(root, "socat", "exit 0");
      writeExecutable(root, "timeout", "exit 0");
      writeExecutable(
        root,
        "apt-get",
        `printf 'invoked' > ${JSON.stringify(marker)}`,
      );
      writeExecutable(root, "sudo", "exit 0");

      const alreadyInstalled = spawnSync("/bin/bash", ["-c", script], {
        env: {
          PATH: root,
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        },
        encoding: "utf8",
      });
      expect(alreadyInstalled.status).toBe(0);
      expect(existsSync(marker)).toBe(false);

      rmSync(join(root, "bwrap"));
      writeExecutable(
        root,
        "timeout",
        'while [[ "${1:-}" == --* || "${1:-}" =~ ^[0-9]+s$ ]]; do shift; done\nexec "$@"',
      );
      writeExecutable(
        root,
        "sudo",
        '[[ "${1:-}" == "-n" ]] && shift\nexec "$@"',
      );
      writeExecutable(root, "apt-get", "exit 0");

      const missingAfterInstall = spawnSync("/bin/bash", ["-c", script], {
        env: {
          PATH: root,
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        },
        encoding: "utf8",
      });
      expect(missingAfterInstall.status).not.toBe(0);
      expect(missingAfterInstall.stderr).toContain(
        "Subprocess isolation helper bwrap is unavailable",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
