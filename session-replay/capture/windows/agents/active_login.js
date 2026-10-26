'use strict';

// Invoke one native mini-program login on WeChat's own task sequence.
// Only one request is allowed per script instance.
const runtime = Process.getModuleByName('flue.dll');
if (runtime.size !== 241516544) throw new Error('Unsupported flue.dll version');
const base = runtime.base;
const keep = [];
let requested = false;
let resultReceived = false;
let liveClosures = 0;

function emit(event, detail) {
  send({event, detail, time: new Date().toISOString()});
}

function verify(offset, expected) {
  const bytes = Array.from(new Uint8Array(base.add(offset).readByteArray(expected.length / 2)))
    .map(v => v.toString(16).padStart(2, '0')).join('');
  if (bytes !== expected) throw new Error('Native entry version mismatch: ' + offset.toString(16));
}

verify(0x35675f0, '4157415641554154565755534881ec28010000');
verify(0x2c5f530, '41565657534883ec68');
verify(0x3d75bd0, '4889c8488b0c244983c006');

function alloc(size) {
  const value = Memory.alloc(size);
  value.writeByteArray(new Uint8Array(size));
  keep.push(value);
  return value;
}

function smallString(text) {
  if (!/^[\x20-\x7e]{0,22}$/.test(text)) throw new Error('Expected short ASCII string');
  const value = alloc(24);
  value.writeUtf8String(text);
  value.add(23).writeU8(text.length);
  return value;
}

function readString(value) {
  const small = value.add(23).readS8();
  const length = small < 0 ? value.add(8).readU64().toNumber() : small;
  if (length < 0 || length > 8192) throw new Error('Unexpected response length');
  return (small < 0 ? value.readPointer() : value).readUtf8String(length);
}

function findHandler() {
  const needle = alloc(8);
  needle.writePointer(base.add(0xbd5d820));
  const pattern = Array.from(new Uint8Array(needle.readByteArray(8)))
    .map(v => v.toString(16).padStart(2, '0')).join(' ');
  const found = [];
  const ranges = Process.enumerateRanges({protection: 'rw-', coalesce: true})
    .filter(r => !r.file && r.size <= 134217728);
  for (const range of ranges) {
    try {
      for (const match of Memory.scanSync(range.base, range.size, pattern)) {
        const handler = match.address;
        const weak = handler.add(16).readPointer();
        if (weak.isNull() || weak.add(4).readU8() !== 0) continue;
        if (!handler.add(24).readPointer().equals(handler)) continue;
        const context = handler.add(8).readPointer();
        const client = context.add(8).readPointer();
        if (client.isNull()) continue;
        const runner = client.add(0x28).readPointer();
        const vtable = runner.readPointer();
        if (!vtable.readPointer().equals(base.add(0x51fc570))) continue;
        found.push({handler, runner, vtable});
      }
    } catch (_) {}
  }
  if (found.length !== 1) throw new Error('Expected one live login handler, found ' + found.length);
  return found[0];
}

function maybeDone() {
  if (resultReceived && liveClosures === 0) {
    setTimeout(() => emit('active.idle', {pendingCallbacks: 0}), 0);
  }
}

function closure(invoke, argTypes, label) {
  const state = alloc(0x40);
  state.writeU32(1);
  const invokeFn = new NativeCallback(invoke, 'void', argTypes);
  const destroyFn = new NativeCallback(() => {
    liveClosures--;
    emit('active.closure-released', {label, pendingCallbacks: liveClosures});
    maybeDone();
  }, 'void', ['pointer']);
  const cancellationFn = new NativeCallback((_, mode) => mode !== 0 ? 1 : 0, 'bool', ['pointer', 'int']);
  keep.push(invokeFn, destroyFn, cancellationFn);
  state.add(8).writePointer(invokeFn);
  state.add(16).writePointer(destroyFn);
  state.add(24).writePointer(cancellationFn);
  const box = alloc(8);
  box.writePointer(state);
  liveClosures++;
  return box;
}

const parseJson = new NativeFunction(base.add(0x2c5f530), 'pointer', ['pointer', 'pointer']);
const freeSized = new NativeFunction(base.add(0x3d435c0), 'void', ['pointer', 'uint64']);
const login = new NativeFunction(base.add(0x35675f0), 'void', ['pointer', 'pointer', 'pointer']);
const locationCtor = new NativeFunction(base.add(0x3d75bd0), 'pointer', ['pointer', 'pointer', 'pointer', 'int']);

rpc.exports = {
  trigger(probeOnly) {
    if (requested) throw new Error('This agent allows one request only');
    const {handler, runner, vtable} = findHandler();
    const isCurrent = new NativeFunction(vtable.add(0x40).readPointer(), 'bool', ['pointer']);
    const post = new NativeFunction(vtable.readPointer(), 'bool', ['pointer', 'pointer', 'pointer', 'int64']);
    const task = closure(() => {
      if (!isCurrent(runner)) {
        resultReceived = true;
        emit('active.error', {message: 'Task did not run on the required sequence'});
        return;
      }
      emit('active.on-sequence', {pid: Process.id, threadId: Process.getCurrentThreadId(), probeOnly});
      if (probeOnly) {
        resultReceived = true;
        emit('active.probe-ok', {requestSent: false});
        return;
      }
      try {
        const request = alloc(0x58);
        Memory.copy(request, smallString('wxaa78bf2905f01cee'), 24);
        Memory.copy(request.add(24), smallString('login'), 24);
        const parsedBox = alloc(8);
        parseJson(parsedBox, smallString('{}'));
        const parsed = parsedBox.readPointer();
        if (parsed.isNull() || parsed.add(24).readU8() !== 6) throw new Error('JSON object parsing failed');
        Memory.copy(request.add(0x30), parsed, 0x20);
        parsed.add(24).writeU8(0xff);
        freeSized(parsed, 0x20);
        const response = closure((_, value) => {
          resultReceived = true;
          try {
            const payload = JSON.parse(readString(value));
            if (typeof payload.code === 'string' && /^[A-Za-z0-9_-]{10,256}$/.test(payload.code)) {
              emit('active.login-code', {appId: 'wxaa78bf2905f01cee', code: payload.code, source: 'native-login-invoke'});
            } else {
              emit('active.login-response', {payload});
            }
          } catch (error) {
            emit('active.error', {message: String(error)});
          }
        }, ['pointer', 'pointer'], 'login-result');
        emit('active.request-start', {appId: 'wxaa78bf2905f01cee', requestCount: 1});
        login(handler, request, response);
        emit('active.request-returned', {callbackConsumed: response.readPointer().isNull()});
      } catch (error) {
        resultReceived = true;
        emit('active.error', {message: String(error)});
      }
    }, ['pointer'], 'posted-task');
    const location = alloc(0x20);
    const name = Memory.allocUtf8String('CodexActiveLogin');
    const file = Memory.allocUtf8String('local:active_login_code.js');
    keep.push(name, file);
    locationCtor(location, name, file, 1);
    requested = true;
    emit('active.attempt-start', {appId: 'wxaa78bf2905f01cee', probeOnly});
    const accepted = post(runner, location, task, 0);
    emit('active.posted', {accepted, callbackConsumed: task.readPointer().isNull(), probeOnly});
    return {accepted, probeOnly, pid: Process.id};
  }
};
