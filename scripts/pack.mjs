import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { artifactPath, runNpm, sdkRoot } from "./artifact.mjs";

if (existsSync(artifactPath)) {
  throw new Error(
    `${basename(artifactPath)} 배포물이 이미 있습니다. SDK 버전을 올리세요.`,
  );
}
const directory = mkdtempSync(join(tmpdir(), "storio-sdk-pack-"));
try {
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
  copyFileSync(
    join(directory, basename(artifactPath)),
    artifactPath,
    constants.COPYFILE_EXCL,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
