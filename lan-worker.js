// Tátão — leitura da placa de rede virtual numa thread separada.
// Fica esperando os pacotes que o sistema manda pra placa (Windows: "TataoLAN" do Wintun; Linux: "tatao0")
// e entrega pro processo principal. Os pacotes são IPv4 puro nos dois, por isso Windows e Linux se entendem.
const { workerData, parentPort } = require("worker_threads");
const koffi = require("koffi");
const stop = workerData.stop; // Int32Array compartilhado: 1 = parar

if (workerData.fd != null) {
  // ---- Linux: lê o TUN "tatao0" (aberto pelo processo principal, sem bloquear) ----
  const C = koffi.load("libc.so.6");
  const read = C.func("long read(int fd, uint8_t *buf, unsigned long n)");
  const poll = C.func("int poll(uint8_t *fds, unsigned long n, int timeout)");
  const fd = workerData.fd, buf = Buffer.alloc(65536), pfd = Buffer.alloc(8);
  pfd.writeInt32LE(fd, 0); pfd.writeInt16LE(1, 4); // POLLIN
  while (Atomics.load(stop, 0) === 0) {
    pfd.writeInt16LE(0, 6);
    if (poll(pfd, 1, 200) <= 0) continue; // sem pacote: espera até 200 ms (pra checar se é pra parar)
    if (pfd.readInt16LE(6) & 0x38) { parentPort.postMessage({ err: "a placa tatao0 foi removida" }); break; } // POLLERR | POLLHUP | POLLNVAL
    for (let i = 0; i < 512; i++) {
      const n = Number(read(fd, buf, 65536));
      if (n <= 0) break;
      const u8 = new Uint8Array(n); u8.set(buf.subarray(0, n));
      parentPort.postMessage(u8, [u8.buffer]);
    }
  }
} else {
  // ---- Windows: Wintun ----
  const L = koffi.load(workerData.dll);
  const K = process.platform === "win32" ? koffi.load("kernel32.dll") : L; // no teste em Linux, a biblioteca simulada traz o WaitForSingleObject

  // sessão e evento chegam como endereço (número), pra serem usados nesta thread
  const receive = L.func("uint8_t *WintunReceivePacket(uint64_t Session, _Out_ uint32_t *PacketSize)");
  const release = L.func("void WintunReleaseReceivePacket(uint64_t Session, uint8_t *Packet)");
  const wait = K.func("uint32_t WaitForSingleObject(uint64_t Handle, uint32_t Milliseconds)");

  const session = workerData.session;
  const event = workerData.event;

  const size = [0];
  while (Atomics.load(stop, 0) === 0) {
    const p = receive(session, size);
    if (p) {
      const n = size[0];
      // copia os bytes (o Electron não deixa apontar direto pra memória do driver) e devolve o buffer pro Wintun
      const u8 = n > 0 && n <= 65535 ? koffi.decode(p, "uint8_t", n) : null;
      release(session, p);
      if (u8) parentPort.postMessage(u8, [u8.buffer]);
      continue;
    }
    wait(event, 200); // sem pacote: dorme até chegar um (ou 200 ms, pra checar se é pra parar)
  }
}
