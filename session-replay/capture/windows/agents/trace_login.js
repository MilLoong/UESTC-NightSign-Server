'use strict';

// Host-side tracer: captures the login body and the outgoing/incoming wire
// bytes on the mini-program login host while exactly one login is triggered.
const traceFlue = Process.getModuleByName('flue.dll');
let tracingLogin = false;
let tracePackets = 0;

function traceEvent(event, detail, data) {
  send({event, detail, time: new Date().toISOString()}, data);
}

function traceBlob(event, pointer, size, detail) {
  if (!tracingLogin || size <= 0 || size > 262144 || tracePackets >= 60) return;
  tracePackets++;
  traceEvent(event, Object.assign({length: size}, detail), pointer.readByteArray(size));
}

function traceLibcppString(pointer) {
  const small = pointer.add(23).readS8();
  const length = small < 0 ? pointer.add(8).readU64().toNumber() : small;
  if (length < 0 || length > 262144) throw new Error('Bad libc++ string');
  return {data: small < 0 ? pointer.readPointer() : pointer, length};
}

function traceMsvcString(pointer) {
  const length = pointer.add(16).readU64().toNumber();
  const capacity = pointer.add(24).readU64().toNumber();
  if (length < 0 || length > 262144 || capacity < length || capacity > 1048576) {
    throw new Error('Bad MSVC string');
  }
  return {data: capacity < 16 ? pointer : pointer.readPointer(), length};
}

Interceptor.attach(traceFlue.base.add(0x35ae8a0), {
  onEnter(args) {
    if (args[1].toUInt32() !== 0x405) return;
    tracingLogin = true;
    try {
      const value = traceLibcppString(args[3]);
      traceBlob('trace.login-body', value.data, value.length, {
        cgiId: 0x405, route: traceLibcppString(args[2]).data.readUtf8String(),
        threadId: Process.getCurrentThreadId()});
    } catch (error) {
      traceEvent('trace.error', {stage: 'login-body', message: String(error)});
    }
  }
});

Interceptor.attach(traceFlue.base.add(0x35ae340), {
  onEnter(args) {
    if (!tracingLogin) return;
    try {
      const value = traceLibcppString(args[3]);
      traceBlob('trace.outer-cgi-request', value.data, value.length, {
        cgiId: args[1].toUInt32(), route: args[2].readUtf8String(),
        threadId: Process.getCurrentThreadId()});
    } catch (error) {
      traceEvent('trace.error', {stage: 'ilink-request', message: String(error)});
    }
  }
});

const traceIlink = Process.getModuleByName('ilink2.dll');
for (const entry of traceIlink.enumerateExports()) {
  if (!entry.name.startsWith('?SendRequestAsync@NetworkManagerNoPB@')) continue;
  const isVoid = entry.name.includes('QEAAX');
  Interceptor.attach(entry.address, {
    onEnter(args) {
      if (!tracingLogin) return;
      try {
        const value = traceMsvcString(args[isVoid ? 1 : 2]);
        traceBlob('trace.ilink-export-request', value.data, value.length, {
          name: entry.name, threadId: Process.getCurrentThreadId()});
      } catch (error) {
        traceEvent('trace.error', {stage: 'ilink-export', message: String(error)});
      }
    }
  });
}

for (const name of ['send', 'WSASend']) {
  Interceptor.attach(Module.getExportByName('ws2_32.dll', name), {
    onEnter(args) {
      if (!tracingLogin) return;
      try {
        if (name === 'send') {
          traceBlob('trace.wire-send', args[1], args[2].toUInt32(), {
            api: name, socket: args[0].toString(),
            stack: Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 10)
              .map(address => {
                const module = Process.findModuleByAddress(address);
                return module ? module.name + '+' + address.sub(module.base) : address.toString();
              })});
        } else {
          const count = Math.min(args[2].toUInt32(), 8);
          for (let index = 0; index < count; index++) {
            const buffer = args[1].add(index * 16);
            traceBlob('trace.wire-send', buffer.add(8).readPointer(), buffer.readU32(), {
              api: name, bufferIndex: index});
          }
        }
      } catch (error) {
        traceEvent('trace.error', {stage: name, message: String(error)});
      }
    }
  });
}

Interceptor.attach(Module.getExportByName('ws2_32.dll', 'recv'), {
  onEnter(args) {
    this.buffer = args[1];
    this.socket = args[0].toString();
  },
  onLeave(result) {
    const length = result.toInt32();
    if (!tracingLogin || length <= 0) return;
    try {
      traceBlob('trace.wire-recv', this.buffer, length, {api: 'recv', socket: this.socket});
    } catch (_) {}
  }
});

rpc.exports.finish = function () {
  tracingLogin = false;
  return {packets: tracePackets};
};
traceEvent('trace.ready', {pid: Process.id, module: traceIlink.name});
