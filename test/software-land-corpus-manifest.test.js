import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GIT_DIFF_TEXT_FINGERPRINT,
  WORKTREE_BYTES_FINGERPRINT,
  fingerprintWorktree,
  gitDiffTextFingerprint,
  readSearchPackageSource,
  refreshCorpusManifest,
} from "../scripts/software-land-corpus-manifest.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CAPTURED_DIFF_SHA256 = "4e1af47321ccfb08d549a80bd41c671f14695047ee48d4592218ac459a668719";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Manifest Test",
  GIT_AUTHOR_EMAIL: "manifest@example.com",
  GIT_COMMITTER_NAME: "Manifest Test",
  GIT_COMMITTER_EMAIL: "manifest@example.com",
};

function git(repo, args) {
  execFileSync("git", ["-C", repo, ...args], { env, stdio: "ignore" });
}

function initRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "sl-manifest-"));
  git(repo, ["init", "-q"]);
  return repo;
}

function writeTarball(repo, version) {
  const stage = mkdtempSync(path.join(tmpdir(), "sl-tarball-"));
  mkdirSync(path.join(stage, "package"));
  writeFileSync(
    path.join(stage, "package", "package.json"),
    `${JSON.stringify({ name: "@software-land/search", version })}\n`
  );
  mkdirSync(path.join(repo, "vendor"), { recursive: true });
  execFileSync("tar", ["-czf", path.join(repo, "vendor", "software-land-search-0.7.0.tgz"), "-C", stage, "package"]);
  rmSync(stage, { recursive: true, force: true });
}

function writePackage(repo) {
  writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({
      name: "software.land",
      dependencies: { "@software-land/search": "file:vendor/software-land-search-0.7.0.tgz" },
    })}\n`
  );
}

describe("software-land corpus manifest source state", () => {
  let repo;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  test("a historical commit's tarball is not replaced by the checkout at the same path", () => {
    repo = initRepo();
    writePackage(repo);
    writeTarball(repo, "0.7.0");
    git(repo, ["add", "package.json", "vendor/software-land-search-0.7.0.tgz"]);
    git(repo, ["commit", "-q", "-m", "vendor 0.7.0"]);
    const historical = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    writeTarball(repo, "0.8.0");
    git(repo, ["add", "vendor/software-land-search-0.7.0.tgz"]);
    git(repo, ["commit", "-q", "-m", "vendor 0.8.0"]);

    expect(readSearchPackageSource(repo, historical).version).toBe("0.7.0");
    expect(readSearchPackageSource(repo, "HEAD").version).toBe("0.8.0");
    const tarball = path.join(repo, "vendor", "software-land-search-0.7.0.tgz");
    const saved = path.join(tmpdir(), `sl-tarball-bytes-${process.pid}.tgz`);
    copyFileSync(tarball, saved);
    const clean = fingerprintWorktree(repo);
    writeTarball(repo, "0.9.0");
    expect(fingerprintWorktree(repo)).not.toBe(clean);
    copyFileSync(saved, tarball);
    expect(fingerprintWorktree(repo)).toBe(clean);
    rmSync(saved, { force: true });

    writeTarball(repo, "0.9.0");
    expect(fingerprintWorktree(repo)).not.toBe(clean);
    expect(() => readSearchPackageSource(repo, historical)).toThrow(/dirty worktree/);
    expect(readSearchPackageSource(repo, "HEAD")).toMatchObject({
      version: "0.9.0",
      commit: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      dirty: true,
    });
  });

  test("changing an untracked article at the same path changes the input fingerprint", () => {
    repo = initRepo();
    writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const clean = fingerprintWorktree(repo);
    expect(fingerprintWorktree(repo)).toBe(clean);

    const article = path.join(repo, "content", "blog", "note", "index.md");
    mkdirSync(path.dirname(article), { recursive: true });
    writeFileSync(article, "alpha\n");
    const alpha = fingerprintWorktree(repo);
    expect(alpha).not.toBe(clean);
    expect(fingerprintWorktree(repo)).toBe(alpha);

    writeFileSync(article, "beta\n");
    const beta = fingerprintWorktree(repo);
    expect(beta).not.toBe(alpha);

    writeFileSync(article, "alpha\n");
    expect(fingerprintWorktree(repo)).toBe(alpha);

    const other = initRepo();
    writeFileSync(path.join(other, "README.md"), "base\n");
    git(other, ["add", "README.md"]);
    git(other, ["commit", "-q", "-m", "base"]);
    const otherArticle = path.join(other, "content", "blog", "note", "index.md");
    mkdirSync(path.dirname(otherArticle), { recursive: true });
    writeFileSync(otherArticle, "alpha\n");
    expect(fingerprintWorktree(other)).toBe(alpha);
    rmSync(other, { recursive: true, force: true });

    rmSync(article);
    git(repo, ["rm", "-q", "README.md"]);
    const removed = fingerprintWorktree(repo);
    expect(removed).not.toBe(clean);
    expect(removed).not.toBe(alpha);
    writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    expect(fingerprintWorktree(repo)).toBe(clean);
  });

  test("a rename is part of the fingerprint and moving it back restores the digest", () => {
    repo = initRepo();
    writeFileSync(path.join(repo, "old.md"), "body\n");
    git(repo, ["add", "old.md"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const clean = fingerprintWorktree(repo);
    git(repo, ["mv", "old.md", "new.md"]);
    const renamed = fingerprintWorktree(repo);
    expect(renamed).not.toBe(clean);
    git(repo, ["mv", "new.md", "old.md"]);
    expect(fingerprintWorktree(repo)).toBe(clean);
  });

  test("the captured fixture digest stays git-diff text, and a new export records worktree bytes", () => {
    const captured = JSON.parse(readFileSync(path.join(ROOT, "fixtures", "software-land", "manifest.json"), "utf8"));
    expect(captured.uncommittedDiffAlgorithm).toBe(GIT_DIFF_TEXT_FINGERPRINT);
    expect(captured.uncommittedDiffSha256).toBe(CAPTURED_DIFF_SHA256);
    expect(captured.uncommittedDiffAlgorithm).not.toBe(WORKTREE_BYTES_FINGERPRINT);

    repo = initRepo();
    writePackage(repo);
    writeTarball(repo, "0.7.0");
    mkdirSync(path.join(repo, "content", "blog"), { recursive: true });
    writeFileSync(path.join(repo, "content", "blog", "index.md"), "committed\n");
    git(repo, ["add", "package.json", "vendor/software-land-search-0.7.0.tgz", "content/blog/index.md"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    const dir = mkdtempSync(path.join(tmpdir(), "sl-fixture-"));
    writeFileSync(path.join(dir, "documents.json"), "[]\n");
    writeFileSync(path.join(dir, "lemmas.json"), "{}\n");
    writeFileSync(path.join(dir, "configured-concepts.json"), "[]\n");
    writeFileSync(
      path.join(dir, "manifest.json"),
      `${JSON.stringify({
        format: "software-land-search-fixture",
        uncommittedDiffAlgorithm: GIT_DIFF_TEXT_FINGERPRINT,
        uncommittedDiffSha256: CAPTURED_DIFF_SHA256,
        files: {},
      })}\n`
    );

    const clean = refreshCorpusManifest({ dir, softwareLand: repo });
    expect(clean.uncommittedDiffAlgorithm).toBe(WORKTREE_BYTES_FINGERPRINT);
    expect(clean.uncommittedDiffSha256).toBe(fingerprintWorktree(repo));
    expect(clean.uncommittedDiffSha256).toBe(gitDiffTextFingerprint(repo));

    const article = path.join(repo, "content", "blog", "note", "index.md");
    mkdirSync(path.dirname(article), { recursive: true });
    writeFileSync(article, "untracked bytes\n");
    const dirty = refreshCorpusManifest({ dir, softwareLand: repo });
    expect(dirty.uncommittedDiffAlgorithm).toBe(WORKTREE_BYTES_FINGERPRINT);
    expect(dirty.uncommittedDiffSha256).toBe(fingerprintWorktree(repo));
    expect(dirty.uncommittedDiffSha256).not.toBe(gitDiffTextFingerprint(repo));
    expect(dirty.uncommittedDiffSha256).not.toBe(CAPTURED_DIFF_SHA256);
    const written = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(written.uncommittedDiffAlgorithm).toBe(WORKTREE_BYTES_FINGERPRINT);
    expect(written.uncommittedDiffSha256).toBe(dirty.uncommittedDiffSha256);
    rmSync(dir, { recursive: true, force: true });
  });
});
