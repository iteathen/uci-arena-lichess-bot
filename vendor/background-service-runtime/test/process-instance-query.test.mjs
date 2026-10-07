import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { NativeResourceHelper } from '../src/native-resource-helper.mjs';

const schema = 'uci_arena_process_instance_query_v1';
const identity = {
  schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 123,
  start_token: '639111234567890123', executable_path: 'C:\\Program Files\\例\\engine.exe', boot_id: '',
};
const helper = () => new NativeResourceHelper({ nativeHelperAvailable: true, nativeHelper: 'C:\\explicit\\guard.exe' });

function response(t, value) {
  t.mock.method(childProcess, 'execFileSync', () => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function realByteOutput(t, bytes) {
  const execute = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (_file, _args, options) => execute(process.execPath,
    ['-e', `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`], options));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

for (const [name, invalid] of [
  ['invalid leading byte', [0xff]],
  ['overlong UTF-8', [0xc0, 0xaf]],
  ['truncated multibyte sequence', [0xe2, 0x82]],
  ['encoded UTF-16 surrogate', [0xed, 0xa0, 0x80]],
  ['code point above Unicode maximum', [0xf4, 0x90, 0x80, 0x80]],
]) {
  test(`real native-output bytes reject ${name} instead of replacing the executable path`, (t) => {
    const envelope = Buffer.from(JSON.stringify({ schema, state: 'present', identity: {
      ...identity, executable_path: 'C:\\runtime\\BYTE_MARKER.exe',
    } }));
    const offset = envelope.indexOf('BYTE_MARKER');
    realByteOutput(t, Buffer.concat([envelope.subarray(0, offset), Buffer.from(invalid),
      envelope.subarray(offset + 'BYTE_MARKER'.length)]));
    assert.deepEqual(helper().queryProcessInstanceSync(123), { schema, state: 'unverifiable' });
  });
}

test('real valid UTF-8 retains Unicode and a literal replacement character in the exact path', (t) => {
  const exact = { ...identity, executable_path: 'C:\\runtime\\界-\uFFFD-\u{1F600}.exe' };
  realByteOutput(t, Buffer.from(JSON.stringify({ schema, state: 'present', identity: exact })));
  assert.deepEqual(helper().queryProcessInstanceSync(123), { schema, state: 'present', identity: exact });
});

test('exact native process query preserves UTC tick precision and explicit invocation bounds', (t) => {
  assert.equal(typeof helper().queryProcessInstanceSync, 'function');
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (...args) => {
    calls.push(args);
    return Buffer.from(JSON.stringify({ schema, state: 'present', identity }));
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(helper().queryProcessInstanceSync(123), { schema, state: 'present', identity });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'C:\\explicit\\guard.exe');
  assert.deepEqual(calls[0][1], ['--query-process-instance', '123']);
  assert.equal(calls[0][2].timeout, 2000);
  assert.equal(calls[0][2].maxBuffer, 262144);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(Object.hasOwn(calls[0][2], 'encoding'), false);
});

test('caller-selected shrinking query budgets reach the native invocation unchanged', (t) => {
  const timeouts = [];
  t.mock.method(childProcess, 'execFileSync', (_file, _args, options) => {
    timeouts.push(options.timeout);
    return Buffer.from(JSON.stringify({ schema, state: 'absent' }));
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const timeoutMs of [1, 137, 2000]) {
    assert.deepEqual(helper().queryProcessInstanceSync(123, { timeoutMs }), { schema, state: 'absent' });
  }
  assert.deepEqual(timeouts, [1, 137, 2000]);
});

test('invalid caller query budgets are rejected before creating any native process', (t) => {
  let calls = 0;
  t.mock.method(childProcess, 'execFileSync', () => {
    calls += 1;
    return Buffer.from(JSON.stringify({ schema, state: 'absent' }));
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const timeoutMs of [0, -1, 1.5, 2001, NaN, Infinity, '137', null, true]) {
    assert.throws(() => helper().queryProcessInstanceSync(123, { timeoutMs }), TypeError);
  }
  assert.equal(calls, 0);
});

test('query admits a domain maximum-length segmented Unicode executable path without truncation', (t) => {
  const components = [...Array(127).fill('界'.repeat(255)), `${'界'.repeat(248)}.exe`];
  const maximum = { ...identity, executable_path: `C:\\${components.join('\\')}` };
  assert.equal(maximum.executable_path.length, 32767);
  assert.ok(components.every((component) => component.length <= 255));
  const envelope = { schema, state: 'present', identity: maximum };
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), 'utf8') < 262144);
  response(t, envelope);
  assert.deepEqual(helper().queryProcessInstanceSync(123).identity, maximum);
});

test('query keeps absent and unverifiable observations distinct', (t) => {
  response(t, { schema, state: 'absent' });
  assert.deepEqual(helper().queryProcessInstanceSync(123), { schema, state: 'absent' });
});

test('unavailable native query fails closed without invoking another process', (t) => {
  let launches = 0;
  t.mock.method(childProcess, 'execFileSync', () => { launches += 1; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(new NativeResourceHelper({ nativeHelperAvailable: false }).queryProcessInstanceSync(123),
    { schema, state: 'unverifiable' });
  assert.equal(launches, 0);
});

test('query requires an explicitly configured absolute helper path', (t) => {
  let launches = 0;
  t.mock.method(childProcess, 'execFileSync', () => { launches += 1; return JSON.stringify({ schema, state: 'absent' }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const nativeHelper of ['guard.exe', '', 'C:guard.exe', '\\guard.exe', '/guard.exe', 'C:\\bad\u0000.exe']) {
    assert.deepEqual(new NativeResourceHelper({ nativeHelperAvailable: true, nativeHelper }).queryProcessInstanceSync(123),
      { schema, state: 'unverifiable' });
  }
  assert.equal(launches, 0);
});

for (const observation of [
  { schema, state: 'present', identity: { ...identity, pid: 124 } },
  { schema, state: 'present', identity: { ...identity, start_token: 639111234567890123 } },
  { schema, state: 'present', identity: { ...identity, start_token: '3155378976000000000' } },
  { schema, state: 'present', identity: { ...identity, executable_path: `C:\\${'x'.repeat(32765)}` } },
  { schema, state: 'present', identity: { ...identity, executable_path: 'relative.exe' } },
  { schema, state: 'present', identity: { ...identity, executable_path: 'C:\\bad\u0000.exe' } },
  { schema, state: 'present', identity: { ...identity, boot_id: 'invented' } },
  { schema, state: 'absent', identity },
  { schema, state: 'unverifiable', details: 'untrusted path or error' },
  { schema: 'unknown', state: 'absent' },
  { schema, state: 'unverifiable' },
  '{malformed',
  ' '.repeat(262145),
]) {
  test(`invalid or unverifiable native response cannot manufacture a present or absent identity: ${JSON.stringify(observation).slice(0, 70)}`, (t) => {
    response(t, observation);
    assert.deepEqual(helper().queryProcessInstanceSync(123), { schema, state: 'unverifiable' });
  });
}

test('query invocation timeout remains unverifiable', (t) => {
  t.mock.method(childProcess, 'execFileSync', () => { throw Object.assign(new Error('untrusted runtime detail'), { code: 'ETIMEDOUT' }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(helper().queryProcessInstanceSync(123), { schema, state: 'unverifiable' });
});

test('invalid PIDs are rejected before native invocation', (t) => {
  let calls = 0;
  t.mock.method(childProcess, 'execFileSync', () => { calls += 1; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const pid of [0, -1, 1.5, '123', 4294967296, NaN]) assert.throws(() => helper().queryProcessInstanceSync(pid), TypeError);
  assert.equal(calls, 0);
});
