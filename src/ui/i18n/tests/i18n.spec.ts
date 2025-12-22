import assert from 'node:assert';
import { getInitialLocale } from '../index';

// In a Node environment without DOM APIs, the initial locale should fall back to 'en'.
assert.strictEqual(getInitialLocale(), 'en');

console.log('i18n SSR-safe initialization test passed');
