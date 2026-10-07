import path from 'node:path';

export function processIdentityTestOraclePath(configuredPath, systemRoot) {
  const selected = configuredPath === undefined
    ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : configuredPath;
  if (typeof selected !== 'string' || /[\u0000\r\n]/u.test(selected) || !selected.isWellFormed()) {
    throw new TypeError('Qualification oracle requires an absolute executable path');
  }
  const root = path.win32.parse(selected).root;
  if (!/^[a-z]:[\\/]/iu.test(root) && !root.startsWith('\\\\')) {
    throw new TypeError('Qualification oracle requires an absolute executable path');
  }
  return selected;
}
