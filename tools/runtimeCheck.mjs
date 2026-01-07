// @ts-nocheck

import { readFile } from 'node:fs/promises';

const fail = (message) => {
  console.error(`\u26a0\uFE0F  Runtime check failed: ${message}`);
  process.exit(1);
};

const parseVersion = (value) => {
  const [major, minor = 0, patch = 0] = value.split('.').map(Number);
  return { major, minor, patch };
};

const compareVersions = (a, b) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

const formatVersion = ({ major, minor, patch }) => `${major}.${minor}.${patch}`;

const parseSupportedRange = (range, engineName) => {
  if (typeof range !== 'string') {
    fail(
      `package.json engines.${engineName} must be a string like ">=20 <21". Detected ${String(range)}.`,
    );
  }

  const trimmed = range.trim();
  const match = trimmed.match(
    /^>=\s*(\d+(?:\.\d+){0,2})\s+<\s*(\d+(?:\.\d+){0,2})$/,
  );

  if (!match) {
    fail(
      `Unsupported engines.${engineName} range "${trimmed}" (supported: ">=X <Y").`,
    );
  }

  return {
    raw: trimmed,
    min: parseVersion(match[1]),
    maxExclusive: parseVersion(match[2]),
  };
};

if (process.env.SKIP_RUNTIME_CHECK === '1') {
  console.warn('\u26a0\uFE0F  Runtime check skipped (SKIP_RUNTIME_CHECK=1).');
  process.exit(0);
}

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageJsonRaw = await readFile(packageJsonUrl, 'utf8');
let packageJson;
try {
  packageJson = JSON.parse(packageJsonRaw);
} catch (err) {
  fail(`Could not parse package.json (${packageJsonUrl.pathname}). ${err}`);
}

const nodeRange = parseSupportedRange(packageJson?.engines?.node, 'node');
const npmRange = parseSupportedRange(packageJson?.engines?.npm, 'npm');

const nodeVersion = parseVersion(process.versions.node);
const parseNpmVersionFromUA = () => {
  const ua = process.env.npm_config_user_agent;
  if (!ua) return null;
  const match = ua.match(/npm\/([0-9.]+)/);
  return match ? parseVersion(match[1]) : null;
};

const npmVersion = process.versions.npm
  ? parseVersion(process.versions.npm)
  : parseNpmVersionFromUA();

if (
  compareVersions(nodeVersion, nodeRange.min) < 0 ||
  compareVersions(nodeVersion, nodeRange.maxExclusive) >= 0
) {
  fail(
    `Node ${nodeRange.raw} required (package.json#engines.node). Detected ${formatVersion(nodeVersion)}.`,
  );
}

if (npmVersion) {
  if (
    compareVersions(npmVersion, npmRange.min) < 0 ||
    compareVersions(npmVersion, npmRange.maxExclusive) >= 0
  ) {
    fail(
      `npm ${npmRange.raw} required (package.json#engines.npm). Detected ${formatVersion(npmVersion)}.`,
    );
  }
} else {
  console.warn(
    `npm version could not be detected; ensure npm ${npmRange.raw} is used to match CI (package.json#engines.npm).`,
  );
}

console.log('\u2705 Runtime check passed: compatible Node/npm versions detected.');
