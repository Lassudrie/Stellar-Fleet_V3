// @ts-nocheck

const fail = (message) => {
  console.error(`\u26a0\uFE0F  Runtime check failed: ${message}`);
  process.exit(1);
};

const parseVersion = (value) => {
  const [major, minor = 0, patch = 0] = value.split('.').map(Number);
  return { major, minor, patch };
};

const formatVersion = ({ major, minor, patch }) => `${major}.${minor}.${patch}`;

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

const minNode = { major: 20, minor: 0, patch: 0 };
const maxNodeExclusiveMajor = 21;

if (
  nodeVersion.major < minNode.major ||
  nodeVersion.major >= maxNodeExclusiveMajor
) {
  fail(`Node ${formatVersion(minNode)} required (< ${maxNodeExclusiveMajor}.0.0). Detected ${formatVersion(nodeVersion)}.`);
}

const minNpm = { major: 10, minor: 0, patch: 0 };
const maxNpmExclusiveMajor = 11;

if (npmVersion) {
  if (
    npmVersion.major < minNpm.major ||
    npmVersion.major >= maxNpmExclusiveMajor
  ) {
    fail(`npm ${formatVersion(minNpm)} required (< ${maxNpmExclusiveMajor}.0.0). Detected ${formatVersion(npmVersion)}.`);
  }
} else {
  console.warn('npm version could not be detected; ensure npm 10.x is used to match CI.');
}

if (process.env.npm_config_user_agent?.includes('npm')) {
  const ua = process.env.npm_config_user_agent;
  if (ua.includes('node/') && !ua.includes('node/v20')) {
    console.warn('Detected npm user agent not reporting Node 20; build reproducibility may be affected.');
  }
}

console.log('\u2705 Runtime check passed: compatible Node/npm versions detected.');
