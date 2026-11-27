import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const sdkRoot = resolve(import.meta.dirname, "..");
export const { name: packageName, version } = JSON.parse(
  readFileSync(join(sdkRoot, "package.json"), "utf8"),
);
export const artifactName = `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

export function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(command)} 종료 코드: ${result.status}`);
  }
}

export function runNpm(args, cwd) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args], cwd);
  } else {
    run(process.env.NPM || "npm", args, cwd);
  }
}

export function packSdk(directory) {
  runNpm(
    [
      "pack",
      "--ignore-scripts",
      "--cache",
      join(directory, ".npm"),
      "--pack-destination",
      directory,
    ],
    sdkRoot,
  );
  return join(directory, artifactName);
}

export async function withSdkInstallation(use, artifact) {
  const directory = mkdtempSync(join(tmpdir(), "backend-sdk-install-"));
  try {
    const artifactPath = artifact ? resolve(artifact) : packSdk(directory);
    runNpm(
      [
        "install",
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(directory, ".npm"),
        artifactPath,
      ],
      directory,
    );
    return await use(directory, artifactPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function withBackendSdk(use, artifact) {
  if (!artifact) runNpm(["run", "build"], sdkRoot);
  return withSdkInstallation(async (directory) => {
    const entry = join(directory, "backend-sdk.mjs");
    writeFileSync(entry, `export * from ${JSON.stringify(packageName)};\n`);
    return use(await import(pathToFileURL(entry)));
  }, artifact);
}
