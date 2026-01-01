// @ts-nocheck

const fail = (message) => {
  console.error(`\u26a0\uFE0F  Runtime check failed: ${message}`);
  process.exit(1);
};

const parseVersion = (value) => {
  const [major, minor = 0, patch = 0] = value.split('.').map(Number);
  return { major, minor, patch };
};

const parseBooleanEnv = (value) => {
  if (!value) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
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

const allowUnsupportedNode = parseBooleanEnv(process.env.ALLOW_UNSUPPORTED_NODE);

const minNode = { major: 20, minor: 0, patch: 0 };
const maxNodeExclusiveMajor = 21;

const isUnsupportedNodeVersion =
  nodeVersion.major < minNode.major || nodeVersion.major >= maxNodeExclusiveMajor;

if (isUnsupportedNodeVersion) {
  const message = `Node ${formatVersion(minNode)} required (< ${maxNodeExclusiveMajor}.0.0). Detected ${formatVersion(nodeVersion)}.`;
  if (allowUnsupportedNode) {
    console.warn(`\u26a0\uFE0F  Runtime check bypassed: ${message} Use at your own risk; CI still enforces Node ${formatVersion(minNode)}.`);
  } else {
    fail(message);
  }
}

const minNpm = { major: 10, minor: 0, patch: 0 };
const maxNpmExclusiveMajor = 11;

if (npmVersion) {
  const isUnsupportedNpm =
    npmVersion.major < minNpm.major || npmVersion.major >= maxNpmExclusiveMajor;
  if (isUnsupportedNpm) {
    const message = `npm ${formatVersion(minNpm)} required (< ${maxNpmExclusiveMajor}.0.0). Detected ${formatVersion(npmVersion)}.`;
    if (allowUnsupportedNode) {
      console.warn(`\u26a0\uFE0F  Runtime check bypassed: ${message} Use at your own risk; CI still enforces npm ${formatVersion(minNpm)}.`);
    } else {
      fail(message);
    }
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
