'use strict';

// Network-side tracer: captures the MMTLS secret, the business response key
// and the actual wire request/response on WeChat's network process.
let wireEnabled = false;
let wireCount = 0;
const wireKdf = new Map();
const wireExpandHooks = new Set();

function wireBuffer(value, maxLength) {
  const length = value.add(16).readU64().toNumber();
  if (length < 0 || length > maxLength) throw new Error('Unexpected MMTLS buffer length');
  return {pointer: value.add(8).readPointer(), length};
}

function wireHex(pointer, length) {
  return Array.from(new Uint8Array(pointer.readByteArray(length)))
    .map(value => value.toString(16).padStart(2, '0')).join('');
}

function wireHookExpand(context) {
  const entry = context.add(0xe8).readPointer().readPointer().add(0x20).readPointer();
  if (wireExpandHooks.has(entry.toString())) return;
  wireExpandHooks.add(entry.toString());
  Interceptor.attach(entry, {
    onEnter(args) {
      this.label = wireKdf.get(Process.getCurrentThreadId());
      if (!wireEnabled || !this.label) return;
      try {
        const secret = wireBuffer(args[1], 128);
        const info = wireBuffer(args[2], 512);
        this.output = args[4];
        this.detail = {
          label: this.label, outputLength: args[3].toUInt32(),
          implementation: entry.sub(wireWeixin.base).toString(),
          secretHex: wireHex(secret.pointer, secret.length),
          infoHex: wireHex(info.pointer, info.length)
        };
      } catch (_) { this.output = null; }
    },
    onLeave(result) {
      if (!this.output) return;
      try {
        const output = wireBuffer(this.output, 256);
        this.detail.outputHex = wireHex(output.pointer, output.length);
        this.detail.returnValue = result.toInt32();
        send({event: 'trace.mmtls-expand', detail: this.detail});
      } catch (_) {}
    }
  });
}

const wireWeixin = Process.getModuleByName('Weixin.dll');
const wireKdfEntry = wireWeixin.base.add(0x671da90);
if (wireHex(wireKdfEntry, 8) !== '5541574156415541') {
  throw new Error('Unsupported Weixin.dll MMTLS build');
}
Interceptor.attach(wireKdfEntry, {
  onEnter(args) {
    if (!wireEnabled) return;
    try {
      const label = wireBuffer(args[2], 100);
      const text = label.pointer.readUtf8String(label.length);
      if (!/^(early data|handshake|application data) key expansion$/.test(text)) return;
      const secret = wireBuffer(args[1], 128);
      const transcript = wireBuffer(args[0].add(0x40), 128);
      wireKdf.set(Process.getCurrentThreadId(), text);
      wireHookExpand(args[0]);
      send({event: 'trace.mmtls-kdf', detail: {
        label: text,
        secretHex: wireHex(secret.pointer, secret.length),
        transcriptHashHex: wireHex(transcript.pointer, transcript.length)
      }});
    } catch (_) {}
  },
  onLeave() {
    wireKdf.delete(Process.getCurrentThreadId());
  }
});

Interceptor.attach(wireWeixin.base.add(0x671e3b0), {
  onEnter(args) {
    const label = wireKdf.get(Process.getCurrentThreadId());
    if (!wireEnabled || !label) return;
    try {
      const keyLength = args[2].toUInt32();
      const otherKeyLength = args[4].toUInt32();
      const ivLength = args[6].toUInt32();
      const otherIvLength = args[8].toUInt32();
      if (![16, 32].includes(keyLength) || otherKeyLength !== keyLength) return;
      if (ivLength !== 12 || otherIvLength !== 12) return;
      send({event: 'trace.mmtls-keys', detail: {
        label,
        clientKeyHex: wireHex(args[1], keyLength),
        serverKeyHex: wireHex(args[3], keyLength),
        clientIvHex: wireHex(args[5], ivLength),
        serverIvHex: wireHex(args[7], ivLength)
      }});
    } catch (_) {}
  }
});

Interceptor.attach(wireWeixin.base.add(0x2e8a5e0), {
  onEnter(args) {
    if (!wireEnabled) return;
    try {
      const keyLength = args[1].toUInt32();
      const aadLength = args[3].toUInt32();
      const cipherLength = args[5].toUInt32();
      if (![16, 24, 32].includes(keyLength) || aadLength > 4096) return;
      if (cipherLength < 28 || cipherLength > 16384) return;
      this.detail = {
        keyHex: wireHex(args[0], keyLength),
        aadHex: wireHex(args[2], aadLength),
        cipherHex: wireHex(args[4], cipherLength)
      };
    } catch (_) {}
  },
  onLeave(result) {
    if (!this.detail || result.toInt32() !== 0) return;
    send({event: 'trace.mmtls-inner-gcm', detail: this.detail});
  }
});

function wireStack(context) {
  return Thread.backtrace(context, Backtracer.ACCURATE).slice(0, 12).map(address => {
    const module = Process.findModuleByAddress(address);
    return module ? module.name + '+' + address.sub(module.base) : address.toString();
  });
}

function wirePacket(event, buffer, size, detail) {
  if (!wireEnabled || size < 8 || size > 262144 || wireCount >= 32) return;
  wireCount++;
  send({event, detail: Object.assign({pid: Process.id, length: size}, detail),
    time: new Date().toISOString()}, buffer.readByteArray(size));
}

for (const name of ['send', 'WSASend']) {
  Interceptor.attach(Module.getExportByName('ws2_32.dll', name), {
    onEnter(args) {
      if (!wireEnabled) return;
      try {
        const detail = {api: name, socket: args[0].toString(), stack: wireStack(this.context)};
        if (name === 'send') {
          wirePacket('trace.main-send', args[1], args[2].toUInt32(), detail);
        } else {
          for (let i = 0; i < Math.min(args[2].toUInt32(), 8); i++) {
            const buffer = args[1].add(i * 16);
            wirePacket('trace.main-send', buffer.add(8).readPointer(), buffer.readU32(), detail);
          }
        }
      } catch (error) {
        send({event: 'trace.wire-error', detail: {message: String(error)}});
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
    if (!wireEnabled || result.toInt32() <= 0) return;
    try {
      wirePacket('trace.main-recv', this.buffer, result.toInt32(), {socket: this.socket});
    } catch (_) {}
  }
});

rpc.exports.enable = function (value) {
  wireEnabled = value;
  return {pid: Process.id, packets: wireCount};
};
