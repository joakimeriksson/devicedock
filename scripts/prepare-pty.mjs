import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { stat, chmod } from 'node:fs/promises';
const require = createRequire(import.meta.url);
// Some node-pty packages omit the executable bit on the macOS spawn helper.
if (process.platform === 'darwin') {
  const root = dirname(require.resolve('node-pty/package.json'));
  const helper = join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  try {
    const info = await stat(helper);
    if (!(info.mode & 0o100)) await chmod(helper, info.mode | 0o100);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
