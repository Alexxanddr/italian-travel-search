import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const publicPaths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const privatePaths = publicPaths.filter((path) => /(?:^|\/)(?:private|node_modules|dist|test-results|playwright-report|\.claude-flow|\.cloudeflow|\.DS_Store)(?:\/|$)|\.(?:hide|local)\.md$/.test(path)
  || path.split("/").some((part) => part.startsWith(".env") && part !== ".env.example"));
assert.deepEqual(privatePaths, [], "Git publication must not contain local environment, private notes or generated artifacts");

const [artifact] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" }));
const privateFiles = artifact.files.filter(({ path }) => /(?:^|\/)(?:private|fixtures|data|\.env)(?:\/|$)|\.(?:hide|local)\.md$/.test(path));
assert.equal(artifact.files.some(({ path }) => path.startsWith("frontend/")), false, "The backend npm package stays independent of frontend tooling");
assert.deepEqual(privateFiles, [], "npm must not contain private notes, fixtures, source data or credentials");
console.log(`${artifact.id}: ${artifact.entryCount} files, no private artifacts`);
