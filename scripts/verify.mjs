import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  artifactPath,
  packageName,
  run,
  sdkRoot,
  version,
  withSdkInstallation,
} from "./artifact.mjs";

function distFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
}

await withSdkInstallation((directory) => {
  const installed = join(directory, "node_modules", packageName);
  const manifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, version);
  const sourceManifest = JSON.parse(
    readFileSync(join(sdkRoot, "package.json"), "utf8"),
  );
  for (const key of [
    "type",
    "exports",
    "files",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    assert.ok(
      JSON.stringify(manifest[key]) === JSON.stringify(sourceManifest[key]),
      `배포물의 package.json ${key} 설정이 현재 명세와 다릅니다. SDK 버전과 배포물을 갱신하세요.`,
    );
  }
  const files = distFiles(join(sdkRoot, "dist"));
  assert.deepEqual(distFiles(join(installed, "dist")), files);
  for (const file of files) {
    assert.ok(
      readFileSync(join(installed, "dist", file)).equals(
        readFileSync(join(sdkRoot, "dist", file)),
      ),
      `배포물의 ${file}이 현재 빌드와 다릅니다. SDK 버전과 배포물을 갱신하세요.`,
    );
  }

  const tests = readdirSync(join(sdkRoot, "test")).filter((file) =>
    file.endsWith(".test.ts"),
  );
  for (const file of ["public-types.mts", ...tests]) {
    copyFileSync(join(sdkRoot, "test", file), join(directory, file));
  }
  run(
    process.execPath,
    [
      join(sdkRoot, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
      "public-types.mts",
    ],
    directory,
  );
  run(process.execPath, ["--test", "--test-timeout=3000", ...tests], directory);
});

const sha256 = createHash("sha256")
  .update(readFileSync(artifactPath))
  .digest("hex");
console.log(
  `${packageName}@${version} ${basename(artifactPath)} sha256=${sha256}`,
);
