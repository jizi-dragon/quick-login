/**
 * Native Messaging 帧协议：4 字节小端长度前缀 + UTF-8 JSON。
 * Chrome 以 stdio 与 host 通信；host 侧任何日志必须走 stderr（stdout 被协议独占）。
 */
export class NmChannel {
  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly onMessage: (msg: unknown) => void,
    private readonly onClose: () => void,
  ) {}

  start(): void {
    let buf = Buffer.alloc(0);
    this.input.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) {
          return;
        }
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) {
          return;
        }
        const frame = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        try {
          this.onMessage(JSON.parse(frame.toString('utf8')));
        } catch (e) {
          console.error('NM frame parse error:', e);
        }
      }
    });
    this.input.on('close', () => this.onClose());
    this.input.on('end', () => this.onClose());
  }

  send(msg: unknown): void {
    const json = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    this.output.write(Buffer.concat([header, json]));
  }
}
