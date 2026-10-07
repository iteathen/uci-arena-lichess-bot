import assert from 'node:assert/strict';
import test from 'node:test';
import { processIdentityTestOraclePath } from './process-identity-test-oracle.mjs';

test('qualification oracle retains the existing absolute Windows PowerShell default', () => {
  assert.equal(processIdentityTestOraclePath(undefined, 'C:\\Windows'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('qualification oracle uses exactly the explicitly selected absolute executable', () => {
  const selected = 'C:\\workflow runtime\\独立\\pwsh.exe';
  assert.equal(processIdentityTestOraclePath(selected, 'C:\\Windows'), selected);
  assert.equal(processIdentityTestOraclePath(selected, undefined), selected);
});

test('qualification oracle rejects ambient and malformed path selection instead of falling back', () => {
  for (const selected of ['pwsh.exe', '.\\pwsh.exe', 'C:pwsh.exe', '\\pwsh.exe', '/pwsh.exe',
    '', 'C:\\bad\u0000.exe', 'C:\\bad\n.exe', null, 23]) {
    assert.throws(() => processIdentityTestOraclePath(selected, 'C:\\Windows'), TypeError);
  }
});
