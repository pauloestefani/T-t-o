// Tátão — leitura da placa de rede virtual (Wintun) numa thread separada.
// Fica esperando pacotes que o Windows manda pra placa "TataoLAN" e entrega pro processo principal.
const { workerData, parentPort } = require("worker_threads");
const koffi = require("koffi");

const L = koffi.load(workerData.dll);
const K = process.platform === "win32" ? koffi.load("kernel32.dll") : L; // no teste em Linux, a biblioteca simulada traz o WaitForSingleObject

// sessão e evento chegam como endereço (número), pra serem usados nesta thread
const receive = L.func("uint8_t *WintunReceivePacket(uint64_t Session, _Out_ uint32_t *PacketSize)");
const release = L.func("void WintunReleaseReceivePacket(uint64_t Session, uint8_t *Packet)");
const wait = K.func("uint32_t WaitForSingleObject(uint64_t Handle, uint32_t Milliseconds)");

const session = workerData.session;
const event = workerData.event;
const stop = workerData.stop; // Int32Array compartilhado: 1 = parar

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
